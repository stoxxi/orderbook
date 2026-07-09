// packages/orderbook/src/orderBook.ts

import { ILogger, noOpLogger } from "./logging";
import { IExchangeMetrics, noOpMetrics } from "./metrics";
import { CURRENT_SCHEMA_VERSION, MAX_QUANTITY_VALUE, MAX_SYSTEM_VAL } from "./constants";
import { Bbo, Depth } from "./depth";
import { FatalEngineError, OrderBookError } from "./errors";
import { isValidSid } from "./idGenerator";
import { createInstrument, Instrument, parseToInternal, toCanonicalDecimal } from "./instrument";
import { Limit } from "./limit";
import { BboListener, DepthListener, OrderListener, TradeListener } from "./listeners";
import {
  fromInternalPrice,
  fromInternalQuantity,
  toInternalPrice,
  toInternalQuantity,
} from "./math";
import { deserializeOrder, Order, OrderState, SerializedOrder } from "./order";
import { OrderMultiMap } from "./orderMultimap";
import { getOrderRejectReasonText, OrderRejectReason } from "./reasons";
import { toBoundedBigInt } from "./serialization";
import { Trade } from "./trade";
import { tradePool } from "./tradePool";
import { Candle, DepthDelta, OrderSid, Price, Quantity, Side, TradeId } from "./types";

/**
 * The structured result returned by OrderBook.add() on success.
 * Throws on rejection (preserving backward compatibility).
 *
 * `status` reflects the order's FINAL state after matching — not whether it
 * had fills (fills and status are orthogonal):
 *   - "FILLED"   → fully executed; `remainingQuantity` is 0.
 *   - "CANCELED" → an IOC residual was canceled (market / protected-market /
 *                  limit-IOC). `fills` may be non-empty (partial IOC) or empty
 *                  (zero-fill IOC); `remainingQuantity` is the canceled,
 *                  never-placed residual. The order is GONE from the book.
 *   - "RESTING"  → the order (or its unfilled remainder) is on the book.
 *                  `fills` may be non-empty (partial fill, remainder rests).
 */
export interface MatchingResult {
  status: "FILLED" | "RESTING" | "CANCELED";
  serverOrderId: string;
  fills: ReadonlyArray<{ price: Price; quantity: Quantity }>;
  remainingQuantity: Quantity;
}

/**
 * Self-Trade Prevention (STP) policy interface.
 *
 * This interface defines the contract for preventing orders from the same user/account
 * from matching against each other. The implementation is intentionally minimal to
 * keep it cheap inside the matching loop, which is the engine's hot path.
 *
 * Performance Note: this is called once per maker order considered during
 * matching — keep implementations to simple field comparisons. For measured
 * throughput/latency numbers see packages/orderbook/BENCHMARKS.md.
 *
 * @template TUserData - The type of user context data attached to orders
 */
export interface STPPolicy<TUserData = unknown> {
  /**
   * Determines if a trade between maker and taker should be prevented.
   *
   * Keep this fast and side-effect-light: simple comparisons that return
   * immediately. It runs inside the matching loop.
   *
   * @param makerOrder - The resting order on the book (price maker)
   * @param takerOrder - The incoming order (price taker)
   * @returns true if the trade should be prevented, false if allowed
   *
   * @example
   * ```typescript
   * shouldPreventTrade(maker, taker) {
   *   return maker.userData?.userId === taker.userData?.userId;
   * }
   * ```
   */
  shouldPreventTrade(makerOrder: Order<TUserData>, takerOrder: Order<TUserData>): boolean;
}

/**
 * Default no-op STP policy that allows all trades.
 * Used when STP is disabled for maximum performance.
 */
export class NoSTPPolicy<TUserData = unknown> implements STPPolicy<TUserData> {
  shouldPreventTrade(): boolean {
    return false; // Never prevent trades
  }
}

/**
 * Standard user-based STP policy that prevents trades between orders
 * from the same userId.
 */
export class UserSTPPolicy<
  TUserData extends { userId?: unknown } = { userId?: unknown },
> implements STPPolicy<TUserData> {
  shouldPreventTrade(makerOrder: Order<TUserData>, takerOrder: Order<TUserData>): boolean {
    // Fast path: if either order lacks user context, allow the trade.
    // `== null` (not `!`) — falsy-but-valid ids like 0 or "" must still
    // be compared, or same-user orders with such ids would self-match.
    const makerUserId = makerOrder.userData?.userId;
    const takerUserId = takerOrder.userData?.userId;

    if (makerUserId == null || takerUserId == null) {
      return false;
    }

    // Prevent trade if same user
    return makerUserId === takerUserId;
  }
}

/**
 * Default precision for standard instruments (e.g., stocks).
 */
const DEFAULT_PRICE_PRECISION = 2; // Cents for USD, EUR, etc.
const DEFAULT_QUANTITY_PRECISION = 0; // Whole shares/units.
const DEFAULT_TICK_SIZE = 1; // Minimum price increment.

// Helper function for comparing bigints
const minBigInt = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// States in which an order can be neither canceled nor replaced (terminal,
// or already pending a cancel/replace). Hoisted to module scope — cancel()
// and replace() previously allocated a fresh array per call for an
// `.includes()` check on this hot-ish path.
const NON_MODIFIABLE_STATES: ReadonlySet<OrderState> = new Set([
  OrderState.FILLED,
  OrderState.CANCELED,
  OrderState.REJECTED,
  OrderState.PENDING_CANCEL,
  OrderState.PENDING_REPLACE,
]);

/**
 * Configuration options for creating an OrderBook.
 */
export interface OrderBookCreateOptions<TUserData = unknown> {
  pricePrecision?: number;
  quantityPrecision?: number;
  tickSize?: string;
  logger?: ILogger; // Allow passing a root logger
  metrics?: IExchangeMetrics;
  /**
   * Self-Trade Prevention policy. If not provided, defaults to NoSTPPolicy
   * which allows all trades for maximum performance.
   */
  stpPolicy?: STPPolicy<TUserData>;
}

/**
 * Point-in-time snapshot of a single order book's resting state.
 * Used for Checkpoint + WAL Delta recovery to eliminate ghost orders on restart.
 *
 * All BigInt fields (price, quantities, serverOrderId) are stored as strings
 * for JSON safety. Pure domain data — the engine-layer IdGenerator state
 * lives in the wrapping VenueSnapshotData (see ShardedExchange), NOT here.
 * This keeps OrderBook unaware of concerns it does not own.
 */
export interface OrderBookSnapshotData {
  schemaVersion: number;        // Must match CURRENT_SCHEMA_VERSION
  symbol: string;
  timestamp: number;
  nextTradeId: number;
  lastTradePrice: string | null; // bigint as string, or null
  orders: SerializedOrder[];    // Serialized via Order.toSerializableObject() — bids then asks, FIFO
  // OB-D3-03: market-data state (24h rolling buckets + in-progress 1-min candle).
  // Optional + un-versioned so old snapshots (written before these fields) still
  // load — importSnapshot defaults them to empty, preserving prior behavior.
  // Closed candles already persist via the Event WAL (KLINE_CLOSED); this carries
  // the *in-progress* candle + the 24h ticker buckets that were otherwise reset to
  // zero on every snapshot-based restart.
  volumeBuckets?: string[];        // 24 × bigint-as-string
  tradeCountBuckets?: number[];    // 24 × number
  lastUpdateHour?: number;
  currentCandle?: {
    open: string; high: string; low: string; close: string; volume: string;
    startMinute: number; closeTime?: number;
  } | null;
}

/**
 * Core matching engine for a single instrument, designed as a single-threaded singleton.
 * Manages bids and asks with price-time priority, optimized for high-frequency trading.
 *
 * **STP Integration:** This OrderBook supports Self-Trade Prevention through a strategy
 * pattern that maintains both logical separation and physical performance. The STP policy
 * is injected at construction time and executed directly in the matching loop (no
 * indirection layers between the policy check and the match decision).
 *
 * **Architecture:** The OrderBook owns the "should I skip this match?" decision point,
 * while the higher-level SimpleExchange owns the policy definition and any complex
 * post-prevention logic (logging, notifications, etc.).
 *
 * The order state machine and rejection reason codes are MODELED AFTER
 * FIX 5.0 SP2 (OrdStatus, tag 39 / OrdRejReason, tag 103) — this is not a
 * claim of full SP2 protocol coverage.
 *
 * **Order State Mappings** (FIX OrdStatus, tag 39):
 * - NEW: OrdStatus=0
 * - PARTIALLY_FILLED: OrdStatus=1
 * - FILLED: OrdStatus=2
 * - CANCELED: OrdStatus=4
 * - PENDING_CANCEL: OrdStatus=6
 * - REJECTED: OrdStatus=8
 * - PENDING_NEW: OrdStatus=A
 * - PENDING_REPLACE: OrdStatus=E
 *
 * **Rejection Reason Mappings** (FIX OrdRejReason, tag 103 — see
 * `reasons.ts` for the authoritative enum, including known deviations
 * like InvalidInvestorID and the custom 99xx/10x ranges):
 * - UnknownOrder: OrdRejReason=5
 * - DuplicateOrder: OrdRejReason=6
 * - IncorrectQuantity: OrdRejReason=13
 * - Other: OrdRejReason=99
 * - InvalidPrice, InvalidTickSize, OrderAlreadyFilled, QtyLessThanFilled,
 *   QtyMustBePositive, NoChange, ConsistencyError: custom 9901–9907 (non-FIX)
 *
 * @template TUserData The shape of user context data attached to orders
 * @template TOrder The specific Order class extending Order<TUserData>
 */
export class OrderBook<TUserData = unknown, TOrder extends Order<TUserData> = Order<TUserData>> {
  public readonly instrument: Instrument;
  private readonly logger: ILogger;
  private readonly metrics: IExchangeMetrics;
  // STP Policy instance - stored as readonly for JIT optimization. The V8 compiler can better optimize when it knows this reference won't change.
  private readonly stpPolicy: STPPolicy<TUserData>;

  private orderListener: OrderListener<TUserData> | null = null;
  private tradeListener: TradeListener<TUserData> | null = null;
  private bboListener: BboListener<TUserData> | null = null;
  private depthListener: DepthListener<TUserData> | null = null;

  private readonly bids = new OrderMultiMap<TOrder>(); // Stores buy orders by price level
  private readonly asks = new OrderMultiMap<TOrder>(); // Stores sell orders by price level
  private readonly orderMap = new Map<OrderSid, TOrder>(); // Maps serverOrderId to Order

  // ─── Server Order IDs ──────────────────────────────────────
  // serverOrderId is assigned by the engine-layer IdGenerator (ShardedExchange)
  // BEFORE any state-mutating call — book.add requires order.serverOrderId to
  // be a valid SID. OrderBook is pure for ID concerns. See IdGenerator.
  //
  // No fallback counter lives here. Tests that call book.add() directly must
  // use the helper in packages/orderbook/__tests__/_helpers.ts which owns its
  // own IdGenerator and assigns SIDs before handing orders to the book.

  private nextTradeId: TradeId = 1; // Incremental trade ID

  // Reentrancy guard: prevents callbacks from calling back into OrderBook
  private isProcessing = false;

  // Deferred callback queue: callbacks executed after state is consistent
  private deferredCallbacks: Array<() => void> = [];

  // Guard against nested flushCallbacks(): a listener callback may legally
  // re-enter the book (isProcessing is false during the flush), and the
  // re-entrant operation's own finally calls flushCallbacks() on the SAME
  // queue. Without this guard the nested flush re-drains from index 0,
  // re-executing callbacks the outer flush already ran (double/unbounded
  // listener invocations). With it, the nested call only enqueues; the
  // outer flush picks new entries up via its dynamic length check.
  private isFlushing = false;

  private depth = new Depth(); // Current order book depth

  // ─── BBO Double-Buffer ──────────────────────────────────────
  // Two pre-allocated Bbo objects; we flip between them via bboIndex, so
  // BBO updates themselves allocate nothing. (This does NOT make the
  // matching path allocation-free overall — see BENCHMARKS.md for
  // measured numbers; snapshots/deferred callbacks still allocate.)
  // LISTENER CONTRACT: BboListener.onBboChange() MUST process the Bbo
  // synchronously or extract primitive values immediately. Holding a
  // reference and deferring processing (e.g., setTimeout) will read
  // corrupted future state when the buffer is reused on the next tick.
  private bboBuffers: [Bbo, Bbo] = [
    { bidPrice: 0n, bidQuantity: 0n, askPrice: 0n, askQuantity: 0n },
    { bidPrice: 0n, bidQuantity: 0n, askPrice: 0n, askQuantity: 0n },
  ];
  private bboIndex = 0; // Points to the CURRENT (readable) buffer
  private bboLastUpdateTs = 0; // Timestamp of last BBO mutation (logical time from sequencer)

  private bboIsDirty = false; // Flag for BBO updates
  private depthIsDirty = false; // Flag for depth updates

  // ─── Market Data: Depth Delta Tracking ─────────────────────
  /** Monotonic sequence number, incremented once per transaction batch that mutates depth. */
  public depthSeq = 0;
  private dirtyBids = new Set<Price>();
  private dirtyAsks = new Set<Price>();

  // ─── Market Data: Rolling 24h Statistics (O(24) fixed memory) ──
  private volumeBuckets = new Array<bigint>(24).fill(0n);
  private tradeCountBuckets = new Array<number>(24).fill(0);
  private lastUpdateHour = 0; // Initialized on first operation via logical timestamp
  /** Price of the most recent trade, or `null` if no trade has occurred yet. */
  public lastTradePrice: Price | null = null;

  // ─── Market Data: Candle Engine ────────────────────────────
  private currentCandle: Candle | null = null;

  // Fills collected during the current add()/replace() call (reset on entry
  // by both; only add() reads it via buildMatchingResult) — safe due to
  // reentrancy guard
  private _currentFills: Array<{ price: Price; quantity: Quantity }> = [];

  // ─── Determinism: Logical Timestamp ────────────────────────
  // Set by the caller (sequencer/gateway) at the start of each public operation.
  // Used by all internal time consumers (BBO, depth, candles, 24h stats).
  // NEVER use Date.now() or performance.now() inside the engine.
  private currentLogicalTs: number = 0;

  constructor(
    instrument: Instrument,
    logger: ILogger = noOpLogger,
    metrics: IExchangeMetrics = noOpMetrics,
    stpPolicy: STPPolicy<TUserData> = new NoSTPPolicy<TUserData>(),
    options?: { silent?: boolean },
  ) {
    this.instrument = instrument;
    this.metrics = metrics;
    this.stpPolicy = stpPolicy;

    // Create a logger scoped specifically to this order book instance
    this.logger = logger.withContext({
      component: "OrderBook",
      symbol: this.instrument.symbol,
    });

    // `silent: true` suppresses the "Order book initialized" log line.
    // Used by `clone()` (sandbox compute creates one OrderBook per
    // command — without this flag every command would emit a fresh
    // "Order book initialized" entry, drowning real signal in logs).
    if (!options?.silent) {
      this.logger.info("Order book initialized", {
        pricePrecision: this.instrument.pricePrecision,
        quantityPrecision: this.instrument.quantityPrecision,
        tickSize: this.instrument.tickSize,
        stpEnabled: !(stpPolicy instanceof NoSTPPolicy),
      });
    }
  }

  /**
   * Creates an OrderBook with default settings.
   * @param symbol Trading symbol (e.g., 'AAPL').
   * @param options Optional precision and tick size configuration.
   * @returns A new OrderBook instance.
   */
  public static create<TUserData = unknown, T extends Order<TUserData> = Order<TUserData>>(
    symbol: string,
    options?: OrderBookCreateOptions<TUserData> & { stpPolicy?: STPPolicy<TUserData> },
  ): OrderBook<TUserData, T> {
    const pricePrecision = options?.pricePrecision ?? DEFAULT_PRICE_PRECISION;
    const quantityPrecision = options?.quantityPrecision ?? DEFAULT_QUANTITY_PRECISION;

    // Step 0: Canonical ingestion (string-first, branded)
    const tickSize = toCanonicalDecimal(options?.tickSize ?? "0.01", pricePrecision);

    // Step 1: Parse tickSize to BigInt immediately (enters BigInt domain)
    const tickSizeInternal = parseToInternal(tickSize, pricePrecision, "tickSize");

    // Step 2: Calculate maxPrice based on SYSTEM LIMITS (15 digits)
    // This ensures economic neutrality (no arbitrary ceilings)
    // MAX_SYSTEM_VAL is imported from constants.ts

    // Step 3: Snap the system max down to a valid tick multiple
    // This guarantees: maxPriceInternal % tickSizeInternal === 0n
    const maxPriceInternal = (MAX_SYSTEM_VAL / tickSizeInternal) * tickSizeInternal;

    // Step 4: Convert back to *canonical* decimal for createInstrument
    const maxPrice = toCanonicalDecimal(
      fromInternalPrice(maxPriceInternal, pricePrecision),
      pricePrecision,
    );

    const instrument = createInstrument(
      symbol,
      pricePrecision,
      quantityPrecision,
      tickSize,
      tickSize, // minPrice = tickSize
      maxPrice, // maxPrice = snapped system ceiling
    );

    return new OrderBook<TUserData, T>(
      instrument,
      options?.logger,
      options?.metrics,
      options?.stpPolicy ?? new NoSTPPolicy<TUserData>(),
    );
  }

  // --- Listener Setup ---

  /**
   * Registers the order-lifecycle listener (accept / reject / fill / cancel /
   * replace events). Replaces any previously registered listener — the book
   * supports exactly one listener per channel; fan out in the host if needed.
   *
   * @remarks
   * Listeners are invoked via a deferred queue after the triggering operation
   * has fully committed its state mutation, so a listener always observes a
   * consistent book. A listener that throws is caught and logged — it cannot
   * corrupt matching (see the reentrancy/error-isolation notes on the class).
   */
  public setOrderListener(listener: OrderListener<TUserData>): void {
    this.orderListener = listener;
  }

  /**
   * Registers the trade listener, called once per consummated trade (and,
   * optionally, on 1-minute candle close). Replaces any previous listener.
   */
  public setTradeListener(listener: TradeListener<TUserData>): void {
    this.tradeListener = listener;
  }

  /**
   * Registers the best-bid/offer listener. Replaces any previous listener.
   *
   * @remarks
   * The `Bbo` passed to the listener is a pre-allocated double-buffer —
   * read it synchronously or copy its primitives immediately; never retain
   * the object reference (see {@link BboListener.onBboChange}).
   */
  public setBboListener(listener: BboListener<TUserData>): void {
    this.bboListener = listener;
  }

  /**
   * Registers the depth listener, called after operations that change the
   * aggregated price ladder. Replaces any previous listener. Marks depth
   * dirty on attach so the first notification reflects the full current
   * book state, not just post-attach deltas.
   */
  public setDepthListener(listener: DepthListener<TUserData>): void {
    this.depthListener = listener;
    // Defensive: the book may have mutated while no listener was attached
    // (rebuilds are lazy). Mark dirty so the listener's first notification
    // reflects the full current state, not just post-attach deltas.
    this.depthIsDirty = true;
  }

  // --- Getters ---

  /** The immutable instrument configuration this book was created with. */
  public getInstrument(): Instrument {
    return this.instrument;
  }

  /** The instrument symbol (shorthand for `getInstrument().symbol`). */
  public getSymbol(): string {
    return this.instrument.symbol;
  }
  /**
   * The current logical timestamp — the sequencer time of the operation being
   * processed (set by add/cancel/replace from `logicalTimestamp`). Deterministic
   * across replay. Exposed so callers that emit derived records inside a
   * listener (e.g. a trade-event journal) can stamp them with logical time
   * rather than `Date.now()`. O(1), no allocation.
   */
  public getCurrentLogicalTs(): number {
    return this.currentLogicalTs;
  }

  // --- Snapshot: Checkpoint + WAL Delta Recovery ---

  /**
   * Exports the full resting state of this order book as a serializable snapshot.
   * Orders are exported bids-first then asks, in price-time priority order (head → tail
   * within each Limit). This preserves FIFO on import.
   *
   * @param symbol The instrument symbol (stored in the snapshot for validation).
   *
   * @example
   * ```ts
   * // Snapshot round-trip: the restored book is byte-for-byte equivalent.
   * const snap = book.exportSnapshot(book.getSymbol());
   * const json = JSON.stringify(snap);           // all bigints already strings
   * const restored = OrderBook.create(book.getSymbol());
   * restored.importSnapshot(JSON.parse(json));
   * // restored.getBbo() === book.getBbo(); replaying the same commands on
   * // both books produces identical trades (determinism contract).
   * ```
   */
  public exportSnapshot(symbol: string): OrderBookSnapshotData {
    const orders: SerializedOrder[] = [];

    // Collect bids: ascending price. Within each Limit, head is oldest (highest priority).
    for (const limit of this.bids.forward()) {
      let node = limit.peekFront();
      while (node) {
        orders.push(node.toSerializableObject());
        node = node._next as TOrder | undefined;
      }
    }
    // Collect asks: ascending price (lowest ask = best ask).
    for (const limit of this.asks.forward()) {
      let node = limit.peekFront();
      while (node) {
        orders.push(node.toSerializableObject());
        node = node._next as TOrder | undefined;
      }
    }

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      symbol,
      timestamp: this.currentLogicalTs,
      nextTradeId: this.nextTradeId,
      lastTradePrice: this.lastTradePrice !== null ? String(this.lastTradePrice) : null,
      orders,
      // OB-D3-03: persist 24h ticker buckets + in-progress candle so they survive
      // a snapshot-based restart (closed candles already persist via KLINE_CLOSED).
      volumeBuckets: this.volumeBuckets.map(String),
      tradeCountBuckets: [...this.tradeCountBuckets],
      lastUpdateHour: this.lastUpdateHour,
      currentCandle:
        this.currentCandle === null
          ? null
          : {
              open: String(this.currentCandle.open),
              high: String(this.currentCandle.high),
              low: String(this.currentCandle.low),
              close: String(this.currentCandle.close),
              volume: String(this.currentCandle.volume),
              startMinute: this.currentCandle.startMinute,
              closeTime: this.currentCandle.closeTime,
            },
    };
  }

  /**
   * Restores this order book from a snapshot. Clears current state first.
   * After import, callers must also re-populate SimpleExchange's index maps and
   * UserOrderManager — use SimpleExchange.importFromOrderBookSnapshot() for that.
   *
   * @throws FatalEngineError if schemaVersion does not match CURRENT_SCHEMA_VERSION.
   */
  public importSnapshot(data: OrderBookSnapshotData): void {
    if (data.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new FatalEngineError(
        `Snapshot schema mismatch: expected ${CURRENT_SCHEMA_VERSION}, got ${data.schemaVersion}. ` +
          `Falling back to full WAL replay.`,
      );
    }

    // ── Phase 1: parse + validate the ENTIRE snapshot into locals BEFORE
    // touching live state. A corrupt/hostile snapshot (bad BigInt string,
    // negative price/quantity, invalid or duplicate SID) must fail loudly here
    // — while the current book is still intact — never leave a half-restored
    // book. Previously this cleared bids/asks/orderMap first and threw mid-loop
    // on order N, leaving orders < N installed and the book neither empty,
    // intact, nor equal to the snapshot.
    const staged: TOrder[] = [];
    const seenSids = new Set<OrderSid>();
    for (const raw of data.orders) {
      const order = deserializeOrder<TUserData>(raw) as TOrder; // throws on bad BigInt/schema
      if (order.price < 0n || order.openQuantity < 0n || order.orderQuantity < 0n) {
        throw new FatalEngineError("Snapshot corruption: negative price/quantity", {
          symbol: this.instrument.symbol,
          orderId: order.orderId,
          price: order.price,
          openQuantity: order.openQuantity,
          path: "orderbook.importSnapshot",
        });
      }
      const sid = order.serverOrderId;
      if (!isValidSid(sid)) {
        throw new FatalEngineError("Snapshot corruption: order has invalid SID", {
          symbol: this.instrument.symbol,
          orderId: order.orderId,
          observedSid: String(sid),
          path: "orderbook.importSnapshot",
        });
      }
      if (seenSids.has(sid)) {
        throw new FatalEngineError("Snapshot corruption: duplicate SID", {
          symbol: this.instrument.symbol,
          orderId: order.orderId,
          serverOrderId: sid,
          path: "orderbook.importSnapshot",
        });
      }
      seenSids.add(sid);

      // P2-1: re-validate against instrument rules — symmetry with the live add()
      // path. The negative/SID/duplicate checks above catch structural corruption;
      // these catch a *semantically* invalid resting order (tick-misaligned price,
      // out-of-bounds price, over-max quantity) that add() would have rejected. A
      // restored book must never hold an order the live path declares impossible.
      // Market orders (price 0) never rest, so tick/bounds apply to limit orders only.
      if (order.isLimit()) {
        if (order.price % this.instrument.tickSize !== 0n) {
          throw new FatalEngineError("Snapshot corruption: price not tick-aligned", {
            symbol: this.instrument.symbol,
            orderId: order.orderId,
            price: order.price,
            tickSize: this.instrument.tickSize,
            path: "orderbook.importSnapshot",
          });
        }
        if (order.price < this.instrument.minPrice || order.price > this.instrument.maxPrice) {
          throw new FatalEngineError("Snapshot corruption: price outside instrument bounds", {
            symbol: this.instrument.symbol,
            orderId: order.orderId,
            price: order.price,
            minPrice: this.instrument.minPrice,
            maxPrice: this.instrument.maxPrice,
            path: "orderbook.importSnapshot",
          });
        }
      }
      if (order.orderQuantity > MAX_QUANTITY_VALUE) {
        throw new FatalEngineError("Snapshot corruption: quantity exceeds system maximum", {
          symbol: this.instrument.symbol,
          orderId: order.orderId,
          orderQuantity: order.orderQuantity,
          path: "orderbook.importSnapshot",
        });
      }

      // openQuantity was only checked for negativity above; bound it too. It
      // feeds limit.totalQuantity, depth aggregates, and the BBO, so an
      // over-max or over-orderQuantity open quantity corrupts the restored
      // book exactly like an over-max orderQuantity would. The `≤ orderQuantity`
      // invariant is what the live fill path maintains (openQuantity only ever
      // decreases from orderQuantity); a snapshot violating it is corrupt.
      if (order.openQuantity > MAX_QUANTITY_VALUE || order.openQuantity > order.orderQuantity) {
        throw new FatalEngineError("Snapshot corruption: openQuantity out of range", {
          symbol: this.instrument.symbol,
          orderId: order.orderId,
          openQuantity: order.openQuantity,
          orderQuantity: order.orderQuantity,
          path: "orderbook.importSnapshot",
        });
      }

      // cumulativeFilledQuantity (FIX CumQty) can never exceed orderQuantity —
      // an order fills at most its own quantity, and the live fill path guards
      // this counter as monotonic (createTrade). A snapshot claiming more filled
      // than ordered is corrupt. (Only the length cap otherwise bounds this
      // field; unlike price/quantity it has no MAX_*_VALUE ceiling to lean on.)
      if (order.cumulativeFilledQuantity > order.orderQuantity) {
        throw new FatalEngineError("Snapshot corruption: cumulativeFilledQuantity exceeds orderQuantity", {
          symbol: this.instrument.symbol,
          orderId: order.orderId,
          cumulativeFilledQuantity: order.cumulativeFilledQuantity,
          orderQuantity: order.orderQuantity,
          path: "orderbook.importSnapshot",
        });
      }

      staged.push(order);
    }

    // Parse counters + market-data state into locals too (toBoundedBigInt can
    // throw — same untrusted-input length cap as the order fields above).
    const nextTradeId = data.nextTradeId;
    const lastTradePrice =
      data.lastTradePrice !== null ? toBoundedBigInt(data.lastTradePrice, "lastTradePrice") : null;
    // OB-D3-03: market-data state. Defaults preserve pre-field behavior for old
    // snapshots that predate these fields (buckets reset to empty, as before).
    const volumeBuckets =
      data.volumeBuckets && data.volumeBuckets.length === 24
        ? data.volumeBuckets.map((v) => toBoundedBigInt(v, "volumeBucket") as Quantity)
        : new Array<Quantity>(24).fill(0n as Quantity);
    const tradeCountBuckets =
      data.tradeCountBuckets && data.tradeCountBuckets.length === 24
        ? [...data.tradeCountBuckets]
        : new Array<number>(24).fill(0);
    const currentCandle =
      data.currentCandle == null
        ? null
        : {
            // Field labels are space-separated (not "candle.open") so a static
            // URL-string scanner can't mistake the word.word shape for a hostname.
            open: toBoundedBigInt(data.currentCandle.open, "candle open") as Price,
            high: toBoundedBigInt(data.currentCandle.high, "candle high") as Price,
            low: toBoundedBigInt(data.currentCandle.low, "candle low") as Price,
            close: toBoundedBigInt(data.currentCandle.close, "candle close") as Price,
            volume: toBoundedBigInt(data.currentCandle.volume, "candle volume") as Quantity,
            startMinute: data.currentCandle.startMinute,
            closeTime: data.currentCandle.closeTime,
          };

    // ── Phase 2: commit. Everything below is total (no throw-points), so a
    // failed import leaves the prior book untouched and a successful one is
    // all-or-nothing.
    this.bids.clear();
    this.asks.clear();
    this.orderMap.clear();
    // Restore orders in export order — preserves price-time priority (FIFO within each level)
    for (const order of staged) {
      this.orderMap.set(order.serverOrderId!, order);
      if (order.side === Side.BUY) {
        this.bids.insert(order);
      } else {
        this.asks.insert(order);
      }
    }

    // Restore local counters. The engine IdGenerator state lives in the
    // wrapping VenueSnapshotData (see ShardedExchange) — OrderBook does not
    // own or restore it here.
    this.nextTradeId = nextTradeId;
    this.lastTradePrice = lastTradePrice;
    // Restore logical timestamp from snapshot for deterministic BBO/depth timestamps
    this.currentLogicalTs = data.timestamp;
    this.volumeBuckets = volumeBuckets;
    this.tradeCountBuckets = tradeCountBuckets;
    this.lastUpdateHour = data.lastUpdateHour ?? 0;
    this.currentCandle = currentCandle;

    // Mark BBO and depth as dirty — they will be recomputed on next dispatchNotifications()
    // call (which happens at the end of every add/cancel/replace).
    // Also force an immediate BBO update so any listener gets correct state right after import.
    this.bboIsDirty = true;
    this.depthIsDirty = true;
    this.updateBbo();
  }

  /**
   * Returns every resting order on this book whose `userData.userId`
   * equals `userId`. Used by the Step 2 sandbox builder (PR1.2 →
   * `cloneUserOrdersForSymbol`) and by the cloneScope discovery pass
   * (Δ users with at least one resting order on this book).
   *
   * Iterates `orderMap.values()` once and filters — O(N_orders).
   * No per-user index is maintained on the book itself; the global
   * `UserOrderManager` is the authoritative per-user index, but this
   * method gives sandbox helpers a book-local source that doesn't
   * require crossing the global manager (and its potentially
   * cross-symbol scope) when a single book's user view is enough.
   *
   * The `userData` shape is generic at the OrderBook level — this
   * method assumes the engine layer's convention that `userData`
   * extends `UserContext` (i.e. carries a `userId` field). Orders with
   * `userData === null` are skipped.
   */
  public getOrdersForUser(userId: unknown): TOrder[] {
    const out: TOrder[] = [];
    for (const order of this.orderMap.values()) {
      const ud = order.userData as { userId?: unknown } | null;
      if (ud !== null && ud !== undefined && ud.userId === userId) {
        out.push(order);
      }
    }
    return out;
  }

  /**
   * Iterates every resting order on the book in `orderMap` insertion
   * order — bids and asks interleaved by `orderMap.set` order, not
   * grouped by side. Used by Step 2's `cloneSymbolLocalState` (§5.1)
   * to enumerate `cloneScope` (distinct `userId`s) and `symbolOrderIds`
   * (every orderId on this symbol) in a single O(N) pass without
   * crossing the global `UserOrderManager`. Caller dedupes `userId`s
   * via `Set`; the digest sorts `symbolOrderIds` before hashing — so
   * iteration order doesn't leak into the hash.
   *
   * Do NOT mutate the book during iteration — the underlying Map's
   * iterator semantics permit deletes-of-yielded-keys but not
   * additions, and we don't want callers to depend on either.
   *
   * ── Contract: NO state filter ────────────────────────────────────
   *
   * This method yields `orderMap.values()` verbatim — there is no
   * `state` predicate applied. By current construction the iterator
   * produces only non-terminal (resting) orders because
   * `removeOrderFromBook` deletes orders from `orderMap` the moment
   * they transition to FILLED or CANCELED. The "resting" in the name
   * is therefore a property of the invariant, not a filter applied
   * here.
   *
   * Callers MUST NOT depend on state-filtering by this method. A
   * future regression in any path that fails to call
   * `removeOrderFromBook` on terminal transition (or that mutates an
   * order's state in place without removing it) would silently leak
   * FILLED/CANCELED orders into this iterator, surprising every
   * downstream consumer. If you need a state-filtered view, filter
   * at the call site (`for (const o of book.iterateRestingOrders())
   * if (o.state === ACTIVE) ...`) — don't assume this method does
   * it for you.
   */
  public *iterateRestingOrders(): Generator<TOrder> {
    yield* this.orderMap.values();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLONE (Step 2 engine-atomicity refactor — see
  // docs/architecture/06-step2-engine-atomicity-refactor.md §5.6)
  //
  // Returns a structural clone of this OrderBook suitable for use as a
  // sandbox in `cloneSymbolLocalState`. The clone shares NO mutable state
  // with the live book — committing the sandbox by reference swap
  // (`liveExchange.book = sandbox.book`) installs the post-compute state
  // without aliasing.
  //
  // Field-completeness: 19 cloned fields per the §5.6 table, exhaustive
  // against `orderBook.ts:188-254`. Missing any one regresses subscriber
  // contracts on the next post-commit reference swap. The transient
  // fields (deferredCallbacks, _currentFills, isProcessing) are reset on
  // the clone — copying them would corrupt the next operation's state.
  //
  // Listeners are reset to null. Sandbox compute does not fire app-layer
  // listeners; the structured-event replay (see §6.2) re-fires them
  // against live listeners after commit.
  //
  // The doubly-linked-list pointer rewiring (`_prev` / `_next` / `_limit`)
  // happens transparently inside `Limit.clone()` via `addOrder()`. No
  // explicit pointer-rebuild pass at this layer.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Structural clone for the Step 2 compute-then-commit pipeline.
   *
   * @returns A new OrderBook sharing no mutable state with `this`.
   *   Mutating the clone (matching, depth updates, candle emission) does
   *   not affect `this`, and vice versa.
   */
  /**
   * Construct a deep clone of this book.
   *
   * @param metricsOverride — optional metrics sink for the clone. When
   *   omitted, the clone shares `this.metrics` by reference (live-use
   *   default). When the clone is for SANDBOX compute, callers MUST pass
   *   `noOpMetrics` (or equivalent) — otherwise the matcher's
   *   `metrics.tradesExecuted.add(1, ...)` (line ~1258) fires on the
   *   LIVE channel during sandbox compute, BEFORE WAL durability. If
   *   Region 1 throws after compute (assertNoMutation, validateUserDeltas,
   *   etc.), the live counter has over-counted trades that never durably
   *   committed — same root cause class as `db554fc` (sandbox/live
   *   duality), opposite leak direction (sandbox → live). See
   *   `feedback_reference_swap_orphans_caches.md`.
   */
  public clone(
    metricsOverride?: IExchangeMetrics,
  ): OrderBook<TUserData, TOrder> {
    // `silent: true` suppresses the "Order book initialized" log line —
    // sandbox compute creates one OrderBook per command and we don't
    // want that init line on the hot path (M1 fix).
    const cloned = new OrderBook<TUserData, TOrder>(
      this.instrument,
      this.logger,
      metricsOverride ?? this.metrics,
      this.stpPolicy,
      { silent: true },
    );

    // Listeners reset to null — sandbox compute doesn't fire to app-layer
    // subscribers (see §6.2 structured-event replay).
    cloned.orderListener = null;
    cloned.tradeListener = null;
    cloned.bboListener = null;
    cloned.depthListener = null;

    // Build live → clone identity map across both sides of the book.
    // Limit.clone populates it as it walks each price level's order list.
    const ordersIdentityMap = new Map<TOrder, TOrder>();

    // Clone bids/asks (deep — full price ladder, FIFO order preserved
    // within each Limit; pointer integrity holds by construction via
    // Limit.addOrder()). The `bids`/`asks` fields are `private readonly`
    // (assignment is a TS-level constraint, not runtime), so we cast for
    // the field replacement. clone() returned a fresh OrderMultiMap; the
    // empty default created by the constructor is discarded.
    (cloned as unknown as { bids: OrderMultiMap<TOrder> }).bids = this.bids.clone(ordersIdentityMap);
    (cloned as unknown as { asks: OrderMultiMap<TOrder> }).asks = this.asks.clone(ordersIdentityMap);

    // Rebuild orderMap using the identity map. Every live entry MUST
    // resolve to a clone Order (orderMap is the per-SID index into the
    // bids/asks ladders — an entry without a corresponding Limit
    // position is a pre-clone book invariant violation).
    for (const [sid, liveOrder] of this.orderMap) {
      const clonedOrder = ordersIdentityMap.get(liveOrder);
      if (clonedOrder === undefined) {
        throw new Error(
          `OrderBook.clone: orderMap entry sid=${sid} has no corresponding Limit position. ` +
            `Pre-clone book invariant violation; cannot safely sandbox.`,
        );
      }
      cloned.orderMap.set(sid, clonedOrder);
    }

    // Trade ID counter — owned by the book, not the engine IdGenerator.
    cloned.nextTradeId = this.nextTradeId;

    // Depth (price-level aggregates for the depth listener fanout).
    // shallowClone() defensively copies each DepthLevel literal.
    (cloned as unknown as { depth: Depth }).depth = this.depth.shallowClone();

    // BBO double-buffer — preserve both buffers AND the index that points
    // at the current readable one. Listener contract requires consistent
    // double-buffer state across the swap.
    cloned.bboBuffers = [{ ...this.bboBuffers[0] }, { ...this.bboBuffers[1] }];
    cloned.bboIndex = this.bboIndex;
    cloned.bboLastUpdateTs = this.bboLastUpdateTs;
    cloned.bboIsDirty = this.bboIsDirty;

    // Depth dirty tracking — partial market-data fanout state.
    cloned.depthIsDirty = this.depthIsDirty;
    cloned.depthSeq = this.depthSeq;
    (cloned as unknown as { dirtyBids: Set<Price> }).dirtyBids = new Set(this.dirtyBids);
    (cloned as unknown as { dirtyAsks: Set<Price> }).dirtyAsks = new Set(this.dirtyAsks);

    // Rolling 24h statistics — kline subscribers depend on these.
    (cloned as unknown as { volumeBuckets: bigint[] }).volumeBuckets = [...this.volumeBuckets];
    (cloned as unknown as { tradeCountBuckets: number[] }).tradeCountBuckets = [
      ...this.tradeCountBuckets,
    ];
    cloned.lastUpdateHour = this.lastUpdateHour;
    cloned.lastTradePrice = this.lastTradePrice;

    // Current candle (1-minute bucket). Spread-clone is sufficient — Candle
    // is a flat POJO of primitives (`types.ts:111-119`).
    (cloned as unknown as { currentCandle: Candle | null }).currentCandle =
      this.currentCandle === null ? null : { ...this.currentCandle };

    // Logical timestamp — caller-set by the sequencer.
    cloned.currentLogicalTs = this.currentLogicalTs;

    // Transient state RESET on the clone (per §5.6 — copying these would
    // corrupt the next operation's state):
    //   - deferredCallbacks: empty (queued during sandbox matching, fire
    //     against the no-op listeners installed above and never reach
    //     live subscribers).
    //   - _currentFills: empty (per-call transient).
    //   - isProcessing / isFlushing: false (clone is quiescent).
    // These are already at their defaults from the constructor; the
    // explicit assignments below document the contract.
    (cloned as unknown as { deferredCallbacks: Array<() => void> }).deferredCallbacks = [];
    (cloned as unknown as { _currentFills: Array<{ price: Price; quantity: Quantity }> })
      ._currentFills = [];
    (cloned as unknown as { isProcessing: boolean }).isProcessing = false;
    (cloned as unknown as { isFlushing: boolean }).isFlushing = false;

    return cloned;
  }

  /**
   * Handles OrderStatusRequest (35=H) per FIX 5.0 SP2.
   * Returns the current state of an order.
   * @param orderSid The server-side ID of the order.
   * @returns The order state or undefined if not found.
   */
  public status(orderSid: OrderSid): OrderState | undefined {
    // Retrieve order from map
    const order = this.orderMap.get(orderSid);
    return order?.state;
  }

  /**
   * The core logic for matching an order and placing it on the book.
   * This is called by both `add()` for new orders and `replace()` for
   * re-submitting orders that have lost time priority.
   * @param order The order to process.
   */
  private _processOrder(order: TOrder): void {
    // Try to match the order immediately with opposite book, then rest residual.
    this.matchOrder(order);

    // Handle remaining quantity
    if (order.openQuantity > 0n) {
      if (order.isIOC()) {
        // Market/Protected orders are IOC: cancel residual
        order.state = OrderState.CANCELED;
        this.logger.info("IOC order residual canceled", {
          orderId: order.orderId,
          serverOrderId: order.serverOrderId,
          canceledQuantity: order.openQuantity.toString(),
          isProtectedMarket: order.isProtectedMarket,
        });
        if (this.orderListener) {
          this.deferCallback(() =>
            this.safeInvokeCallback("onCancel", () =>
              this.orderListener!.onCancel(order.snapshot()),
            ),
          );
        }
        this.orderMap.delete(order.serverOrderId!);
      } else if (order.state === OrderState.NEW || order.state === OrderState.PARTIALLY_FILLED) {
        // Only limit orders rest
        const book = this.getBookBySide(order.side);
        book.insert(order);
        this.markDepthDirty(order.side, order.price);
        this.bboIsDirty = true;
        this.depthIsDirty = true;
      }
    }
  }

  private getBookBySide(side: Side): OrderMultiMap<TOrder> {
    return side === Side.BUY ? this.bids : this.asks;
  }

  /**
   * Guards against reentrancy by checking and rejecting reentrant calls.
   * All public mutating methods MUST be wrapped with this guard.
   */
  private guardReentrancy(operation: string): void {
    if (this.isProcessing) {
      throw new OrderBookError(
        OrderRejectReason.Other,
        `Reentrancy detected: cannot call ${operation} from within a listener callback`,
      );
    }
  }

  /**
   * Safely invokes a listener callback with exception handling.
   * Logs errors but does not allow them to propagate.
   */
  private safeInvokeCallback(callbackName: string, callback: () => void): void {
    try {
      const result = callback() as unknown;
      // EXCH-D5-04: listeners are SYNCHRONOUS by contract — the matching loop never
      // awaits them. If one returns a thenable anyway (a contract violation), we must
      // NOT await on the hot path, but we also must not let its rejection float
      // silently. Attach a handler so it surfaces loudly instead of vanishing.
      if (result && typeof (result as { then?: unknown }).then === "function") {
        (result as Promise<unknown>).catch((err) =>
          this.logger.error(
            `Listener callback '${callbackName}' returned a rejected promise (listeners must be synchronous)`,
            err as Error,
            { symbol: this.instrument.symbol, callbackType: callbackName },
          ),
        );
      }
    } catch (err) {
      // CRITICAL: Log but do not propagate user callback exceptions
      this.logger.error(`Listener callback '${callbackName}' threw exception`, err as Error, {
        symbol: this.instrument.symbol,
        callbackType: callbackName,
      });
    }
  }

  /**
   * Defers a callback to be executed after current operation completes.
   * Ensures all internal state is consistent before listeners run.
   */
  private deferCallback(callback: () => void): void {
    this.deferredCallbacks.push(callback);
  }

  /**
   * Executes all deferred callbacks in FIFO order.
   */
  private flushCallbacks(): void {
    // Re-entrant flush (a callback re-entered the book and its finally is
    // flushing again): no-op — the outer flush owns the drain and will reach
    // the newly enqueued callbacks via the dynamic length check below.
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      // Index-based drain: O(N) instead of O(N²) from Array.shift().
      // Uses dynamic .length check (not cached) so callbacks enqueued
      // during flush are processed in the same cycle (preserves event ordering).
      let i = 0;
      while (i < this.deferredCallbacks.length) {
        this.deferredCallbacks[i++]();
      }
      this.deferredCallbacks.length = 0; // O(1) clear without reallocation
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Submits a new order to the book.
   * - Transitions: PENDING_NEW → NEW → (PARTIALLY_FILLED → FILLED) or REJECTED.
   * - Matches against resting orders with STP prevention.
   * - Limit orders rest if quantity remains; market orders are cancelled (IOC).
   * @param order The order to add.
   * @param logicalTimestamp Deterministic timestamp from the sequencer
   *   (ms since epoch — typically `command.timestamp` from
   *   `Proto.AssignedCommand`). Threaded into `currentLogicalTs` and
   *   propagated to `Depth.lastChange` / `Bbo.lastUpdateTs` / candle
   *   timestamps; required for §6.6 replay determinism. The live path
   *   through `SimpleExchange.processCommand` always passes the command's
   *   ingress time. When omitted (direct test callers / ad-hoc scripts) the
   *   engine reuses the LAST logical timestamp — a deterministic fallback, so
   *   a caller that forgets the argument can never inject wall-clock time into
   *   replayable state (`Date.now()` here would diverge a WAL replay).
   * @returns A {@link MatchingResult} describing what happened synchronously:
   *   terminal status (`FILLED` / `RESTING` / `CANCELED`), the assigned
   *   server order id, per-price fills, and the remaining quantity.
   * @throws {OrderBookError} On rejection (invalid price/tick/quantity, etc.).
   *   The structured reject also fires via `onReject` with the same code; the
   *   order is NOT on the book.
   * @throws {FatalEngineError} On identity/consistency violations (missing or
   *   colliding `serverOrderId`, internal invariant breaks) — treat the book
   *   as corrupt and halt; do not catch and continue.
   *
   * @example
   * ```ts
   * const book = OrderBook.create("DEMO");
   * const idGen = new IdGenerator();
   * const order = new Order("client-1", Side.BUY, book.toInternalPrice("10.00"), 5n);
   * order.serverOrderId = idGen.next(); // assign identity BEFORE adding
   * const result = book.add(order, sequencerTimestampMs);
   * // result.status === "RESTING" on an empty book; result.fills lists any matches
   * ```
   */
  public add(order: TOrder, logicalTimestamp?: number): MatchingResult {
    this.currentLogicalTs = logicalTimestamp ?? this.currentLogicalTs;

    // Fail-Fast: Null Check (Defense in Depth)
    if (!order) {
      throw new OrderBookError(OrderRejectReason.Other, "Order object cannot be null or undefined");
    }

    // Security: Prevent BigInt OOM/DDoS via extreme quantity (BigInt Bomb Protection)
    if (order.orderQuantity > MAX_QUANTITY_VALUE) {
      throw new OrderBookError(
        OrderRejectReason.IncorrectQuantity,
        "Quantity exceeds system maximum",
      );
    }

    this.guardReentrancy("add");
    this.isProcessing = true;
    this._currentFills = [];

    try {
      // Set initial state
      order.state = OrderState.PENDING_NEW;

      // Validate order parameters
      this.validateOrder(order);

      // Identity invariant: the order must carry a valid SID assigned by the
      // engine-layer IdGenerator before reaching this point. See the trust-
      // boundary map at the top of packages/orderbook/src/idGenerator.ts.
      if (!isValidSid(order.serverOrderId)) {
        throw new FatalEngineError(
          `OrderBook.add invariant violation: order.serverOrderId must be a valid SID ` +
            `assigned by the engine. Got ${String(order.serverOrderId)}.`,
          {
            symbol: this.instrument.symbol,
            clientOrderId: order.orderId,
            observedSid: String(order.serverOrderId),
            path: "orderbook.add",
          },
        );
      }

      // Collision guard: the engine's IdGenerator is monotonic, so a collision
      // means either a double-apply of the same command or a SID was issued
      // below the book's high-water mark. Either is a fatal engine bug.
      if (this.orderMap.has(order.serverOrderId)) {
        throw new FatalEngineError(
          `SID collision: ${order.serverOrderId} already present in book ${this.instrument.symbol}. ` +
            `IdGenerator monotonicity invariant violated.`,
          {
            symbol: this.instrument.symbol,
            clientOrderId: order.orderId,
            serverOrderId: order.serverOrderId,
            type: "ADD_ORDER",
            path: "orderbook.add",
          },
        );
      }

      this.logger.debug("New order accepted", {
        orderId: order.orderId,
        serverOrderId: order.serverOrderId,
      });
      if (this.orderListener) {
        this.deferCallback(() =>
          this.safeInvokeCallback("onAccept", () =>
            this.orderListener!.onAccept(order.snapshot()),
          ),
        );
      }

      // Transition to NEW state and add to the master map
      order.state = OrderState.NEW;
      this.orderMap.set(order.serverOrderId, order);

      // Delegate matching and placement to the core processing method
      this._processOrder(order);

      // Notify listeners of BBO/depth changes
      this.dispatchNotifications();

      return this.buildMatchingResult(order, this._currentFills);
    } catch (err) {
      if (err instanceof OrderBookError) {
        order.state = OrderState.REJECTED;
        if (this.orderListener) {
          this.deferCallback(() =>
            this.safeInvokeCallback("onReject", () =>
              this.orderListener!.onReject(order.snapshot(), err.code, err.message),
            ),
          );
        }

        throw err;
      } else {
        // If it's an unexpected error, we should not swallow it.
        // Re-throwing it will make the test suite fail loudly, which is good.
        this.logger.fatal("An unexpected error occurred during order addition", err as Error, {
          orderId: order?.orderId,
        });
        // Re-throw unexpected errors to signal a potential system failure
        throw err;
      }
    } finally {
      this.isProcessing = false;
      this.flushCallbacks();
    }
  }

  /**
   * Cancels an order.
   * - Transitions: NEW/PARTIALLY_FILLED → PENDING_CANCEL → CANCELED or revert.
   * - Rejects if order is not found or in invalid state.
   * @param orderSid The server-side ID of the order.
   * @param logicalTimestamp Deterministic timestamp from the sequencer
   *   (ms since epoch — typically `command.timestamp` from
   *   `Proto.AssignedCommand`). Required for §6.6 replay determinism. The live
   *   path always passes the command's ingress time; when omitted the engine
   *   reuses the LAST logical timestamp (deterministic fallback — never
   *   `Date.now()`, which would diverge a WAL replay).
   *
   * @remarks
   * Outcomes are reported through the order listener, not the return value:
   * success fires `onCancel`; a missing/terminal order fires `onCancelReject`
   * with a structured {@link OrderRejectReason}. Cancel is O(1) — the order
   * is located via the sid map and unlinked from its price level's intrusive
   * doubly-linked list without scanning.
   *
   * @example
   * ```ts
   * book.cancel(order.serverOrderId!, sequencerTimestampMs);
   * // → listener.onCancel(snapshot) on success,
   * //   listener.onCancelReject(snapshot|null, code, text) otherwise
   * ```
   */
  public cancel(orderSid: OrderSid, logicalTimestamp?: number): void {
    this.currentLogicalTs = logicalTimestamp ?? this.currentLogicalTs;
    this.guardReentrancy("cancel");
    this.isProcessing = true;

    // Retrieve order
    const order = this.orderMap.get(orderSid);

    try {
      if (!order)
        throw new OrderBookError(OrderRejectReason.UnknownOrder, `SID ${orderSid} not found.`);

      // Invariant: Live orders must have a limit pointer
      const limit = order._limit;
      if (limit === null) {
        // Already filled or cancelled
        throw new OrderBookError(OrderRejectReason.Other, "Order is already terminal.");
      }

      // Check for ALL non-cancellable states
      if (NON_MODIFIABLE_STATES.has(order.state)) {
        const reason =
          order.state === OrderState.FILLED
            ? OrderRejectReason.OrderAlreadyFilled
            : OrderRejectReason.Other;
        throw new OrderBookError(
          reason,
          `Cannot cancel order in state '${OrderState[order.state]}'.`,
        );
      }

      // Transition to pending cancel
      const previousState = order.state;
      order.state = OrderState.PENDING_CANCEL;

      // Attempt to remove from book
      if (limit.removeOrder(order)) {
        order.state = OrderState.CANCELED;
        this.orderMap.delete(orderSid);

        // Clean up empty price level to prevent zombie Limits in the tree.
        // Without this, matchOrder's outer loop spins infinitely on empty Limits
        // that getBestReverse() keeps returning while bookToMatch.size() > 0.
        if (limit.isEmpty()) {
          const book = this.getBookBySide(order.side);
          book.removePriceLevel(order.price);
        }

        // DEBUG-level: AMM tick cancels at ~30 k/min make this the second-
        // largest source of engine log volume (~20% after constructor noise).
        // Operational visibility for real user cancels is still preserved
        // by app-layer `onCancel` listener which emits structured events.
        // See issue #57 + 2026-05-14 ENOSPC outage.
        this.logger.debug("Order canceled successfully", {
          orderId: order.orderId,
          serverOrderId: order.serverOrderId,
        });
        if (this.orderListener) {
          this.deferCallback(() =>
            this.safeInvokeCallback("onCancel", () =>
              this.orderListener!.onCancel(order.snapshot()),
            ),
          );
        }
        this.markDepthDirty(order.side, order.price);
        this.bboIsDirty = true;
        this.depthIsDirty = true;
      } else {
        // Revert state on failure
        order.state = previousState;
        throw new OrderBookError(
          OrderRejectReason.ConsistencyError,
          "Order found in map but not in book; cannot cancel.",
        );
      }

      this.dispatchNotifications();
    } catch (err) {
      if (err instanceof OrderBookError) {
        if (this.orderListener) {
          // Defer like add()'s onReject so the callback runs from the
          // finally's flushCallbacks() AFTER isProcessing=false — a listener
          // may re-enter the book from a reject callback. (JS finally
          // semantics: the flush still runs before this throw reaches the
          // caller.) Capture the snapshot and error fields eagerly — state
          // may shift before the deferred callback fires.
          const orderSnapshot = order?.snapshot() ?? null;
          const code = err.code;
          const message = err.message;
          this.deferCallback(() =>
            this.safeInvokeCallback("onCancelReject", () =>
              this.orderListener!.onCancelReject(orderSnapshot, code, message),
            ),
          );
        }
        throw err;
      } else {
        this.logger.fatal("An unexpected error occurred during order cancellation", err as Error, {
          serverOrderId: orderSid.toString(),
        });
        throw err;
      }
    } finally {
      this.isProcessing = false;
      this.flushCallbacks();
    }
  }

  /**
   * Modifies an existing order, adhering to FIX protocol standards for time priority.
   * - Transitions: NEW/PARTIALLY_FILLED → PENDING_REPLACE → NEW/PARTIALLY_FILLED/FILLED or revert.
   * - Price changes or quantity increases lose time priority; quantity decreases retain it.
   * - Handles case where quantity decrease results in FILLED state.
   * @param orderSid The server-side ID of the order.
   * @param newQuantity The new total quantity.
   * @param newPrice The new price.
   * @param logicalTimestamp Deterministic timestamp from the sequencer
   *   (ms since epoch — typically `command.timestamp` from
   *   `Proto.AssignedCommand`). Required for §6.6 replay determinism. The live
   *   path always passes the command's ingress time; when omitted the engine
   *   reuses the LAST logical timestamp (deterministic fallback — never
   *   `Date.now()`, which would diverge a WAL replay).
   *
   * @remarks
   * Outcomes are reported through the order listener: success fires
   * `onReplace` (with old and new price/quantity); an invalid request fires
   * `onReplaceReject` — including `NoChange` when both values are unchanged.
   * A replace that loses time priority may match immediately at its new price.
   *
   * @example
   * ```ts
   * // Halve the quantity (retains time priority), keep the price:
   * book.replace(sid, 50n, order.price, sequencerTimestampMs);
   * // Move the price (loses priority, may trade immediately):
   * book.replace(sid, 50n, book.toInternalPrice("10.05"), sequencerTimestampMs);
   * ```
   */
  public replace(orderSid: OrderSid, newQuantity: Quantity, newPrice: Price, logicalTimestamp?: number): void {
    this.currentLogicalTs = logicalTimestamp ?? this.currentLogicalTs;
    this.guardReentrancy("replace");
    this.isProcessing = true;
    // Hygiene: the lost-priority path below re-matches via _processOrder →
    // createTrade, which pushes into _currentFills. Only add() reads the
    // buffer (buildMatchingResult), and add() resets it on entry — but
    // without this reset, replace-generated fills would sit in the buffer
    // until the next add() call. Keep the lifecycle symmetric.
    this._currentFills = [];

    // Retrieve order
    const order = this.orderMap.get(orderSid);

    try {
      if (!order) {
        throw new OrderBookError(OrderRejectReason.UnknownOrder, `SID ${orderSid} not found.`);
      }

      // Capture Audit Trail BEFORE mutation
      const oldQuantity = order.orderQuantity;
      const oldPrice = order.price;

      // Check for ALL non-replaceable states
      if (NON_MODIFIABLE_STATES.has(order.state)) {
        const reason =
          order.state === OrderState.FILLED
            ? OrderRejectReason.OrderAlreadyFilled
            : OrderRejectReason.Other;
        throw new OrderBookError(
          reason,
          `Cannot replace order in state '${OrderState[order.state]}'.`,
        );
      }

      // Validate replace request
      this.validateReplace(order, newQuantity, newPrice);

      // Transition to pending replace
      const previousState = order.state;
      order.state = OrderState.PENDING_REPLACE;

      const filledQuantity = order.orderQuantity - order.openQuantity;
      const isPriceChange = newPrice !== order.price;
      const isQtyIncrease = newQuantity > order.orderQuantity;

      if (isPriceChange || isQtyIncrease) {
        // Price change or quantity increase loses time priority
        if (!this.removeOrderFromBook(order)) {
          order.state = previousState;
          throw new OrderBookError(
            OrderRejectReason.ConsistencyError,
            "Order found in map but not in book during replace.",
          );
        }

        // Update order parameters and re-add to book
        order.price = newPrice;
        order.orderQuantity = newQuantity;
        order.openQuantity = newQuantity - filledQuantity;

        // Set the correct state before re-processing.
        // If it was partially filled, it remains so. Otherwise, it's NEW.
        order.state = filledQuantity > 0n ? OrderState.PARTIALLY_FILLED : OrderState.NEW;
        this.logger.info("Order replaced (lost priority)", {
          orderId: order.orderId,
          serverOrderId: order.serverOrderId,
          newPrice: newPrice.toString(),
          newQuantity: newQuantity.toString(),
        });

        if (this.orderListener) {
          this.deferCallback(() =>
            this.safeInvokeCallback("onReplace", () =>
              this.orderListener!.onReplace(
                order.snapshot(),
                oldQuantity,
                oldPrice,
                newQuantity,
                newPrice,
              ),
            ),
          );
        }

        // Mark old price level dirty before re-processing at new price
        this.markDepthDirty(order.side, oldPrice);

        // Re-submit to handle matching and placement WITHOUT resetting state to PENDING_NEW
        this._processOrder(order);

        // Re-add to orderMap if the order is still resting after match-and-place.
        // `removeOrderFromBook` (line 1052 above) cleared the entry, and
        // `_processOrder` re-inserts into the side multimap but does NOT touch
        // orderMap. Without this, downstream `book.getOrder(sid)` lookups (e.g.
        // `simpleExchange` onFill at line 1362 — `order.releasedAmount += release`)
        // silently miss the order, leaving order fields stale while the userManager
        // accumulator updates. That asymmetry surfaced as snap-pair drift in the
        // 2026-05-13 property-test run; fixing at the orderMap source keeps the
        // ADD-vs-REPLACE behaviours symmetric.
        if (
          order.state === OrderState.NEW ||
          order.state === OrderState.PARTIALLY_FILLED
        ) {
          this.orderMap.set(order.serverOrderId!, order);
        }
      } else {
        // --- QUANTITY DECREASE PATH ---
        const quantityDelta = newQuantity - order.orderQuantity;
        const newOpenQuantity = newQuantity - filledQuantity;

        // v3.5.2 Fix: Handle the "Race-to-Zero"
        // If reducing quantity results in a filled order, remove from book first
        // to avoid the "Zero total quantity but orders present" consistency check
        // failure in OrderMultiMap.
        if (newOpenQuantity === 0n) {
          this.removeOrderFromBook(order);
        } else {
          const bookSide = this.getBookBySide(order.side);
          try {
            bookSide.updateQuantity(order, quantityDelta);
          } catch (err) {
            order.state = previousState;
            this.logger.fatal("Order book consistency error during replace", err as Error, {
              orderSid: orderSid.toString(),
              orderId: order.orderId,
            });
            throw new OrderBookError(OrderRejectReason.ConsistencyError, "In-place update failed.");
          }
        }

        // Update parameters
        order.orderQuantity = newQuantity;
        order.openQuantity = newOpenQuantity;

        // Update state
        order.state = order.isFilled()
          ? OrderState.FILLED
          : filledQuantity > 0n
            ? OrderState.PARTIALLY_FILLED
            : OrderState.NEW;

        this.logger.info("Order replaced (retained priority)", {
          orderId: order.orderId,
          serverOrderId: order.serverOrderId,
          newQuantity: newQuantity.toString(),
        });
        if (this.orderListener) {
          this.deferCallback(() =>
            this.safeInvokeCallback("onReplace", () =>
              this.orderListener!.onReplace(
                order.snapshot(),
                oldQuantity,
                oldPrice,
                newQuantity,
                newPrice,
              ),
            ),
          );
        }
        this.markDepthDirty(order.side, order.price);
        this.bboIsDirty = true;
        this.depthIsDirty = true;
      }

      this.dispatchNotifications();
    } catch (err) {
      if (err instanceof OrderBookError) {
        if (this.orderListener) {
          // Deferred like onCancelReject above (and add()'s onReject) —
          // see the comment in cancel()'s catch block. Eager capture is
          // required for the same reason.
          const orderSnapshot = order?.snapshot() ?? null;
          const code = err.code;
          const message = err.message;
          this.deferCallback(() =>
            this.safeInvokeCallback("onReplaceReject", () =>
              this.orderListener!.onReplaceReject(orderSnapshot, code, message),
            ),
          );
        }
        throw err;
      } else {
        this.logger.fatal("An unexpected error occurred during order replacement", err as Error, {
          serverOrderId: orderSid.toString(),
        });
        throw err;
      }
    } finally {
      this.isProcessing = false;
      this.flushCallbacks();
    }
  }

  /**
   * Matches an incoming order against resting orders using price-time priority.
   *
   * **STP Integration Point:** This is where Self-Trade Prevention is physically
   * executed in the matching loop — a direct stpPolicy.shouldPreventTrade()
   * call per maker order considered, with no indirection layers.
   *
   * **Performance:** This is the engine's hot path — keep it lean, avoid
   * adding per-iteration allocations or indirection. (Each matched trade
   * still allocates snapshots, deferred-callback closures and a fills entry;
   * the trade pool saves exactly the Trade object.) For measured throughput
   * see packages/orderbook/BENCHMARKS.md. The STP check is positioned to
   * fail-fast when prevention is needed, minimizing unnecessary work.
   *
   * @param takingOrder The incoming order to match.
   */
  private matchOrder(takingOrder: TOrder): void {
    const isBuy = takingOrder.side === Side.BUY;
    const bookToMatch = isBuy ? this.asks : this.bids; // Match against opposite side

    // Continue matching while taker has quantity and book has orders
    while (takingOrder.openQuantity > 0n && bookToMatch.size() > 0) {
      // Get best price level (lowest ask or highest bid)
      const bestLimit = isBuy ? bookToMatch.getBest() : bookToMatch.getBestReverse();
      if (!bestLimit) break;

      // Check if prices cross
      const canMatch =
        takingOrder.isMarket() ||
        (isBuy ? takingOrder.price >= bestLimit.price : takingOrder.price <= bestLimit.price);
      if (!canMatch) break;

      // Process orders at this price level
      while (!bestLimit.isEmpty() && takingOrder.openQuantity > 0n) {
        // Peek at the best order without removing it
        const makingOrder = bestLimit.peekFront()!;

        // **STP HOT PATH:** Execute self-trade prevention check
        // This call will be inlined by V8 JIT after ~1000 iterations
        if (this.stpPolicy.shouldPreventTrade(makingOrder, takingOrder)) {
          // Self-trade detected - skip this maker order
          // Remove the making order from the book to prevent future matches
          bestLimit.popFront();
          this.orderMap.delete(makingOrder.serverOrderId!);

          // Update the making order state and notify
          makingOrder.state = OrderState.CANCELED;
          this.logger.debug("Self-trade prevented - maker order canceled", {
            makerOrderId: makingOrder.orderId,
            takerOrderId: takingOrder.orderId,
            // Log only the scalar userId, never the whole userData object —
            // it may carry PII (email, etc.) and this record names TWO users.
            makerUserId: (makingOrder.userData as { userId?: unknown } | null)?.userId,
            takerUserId: (takingOrder.userData as { userId?: unknown } | null)?.userId,
          });
          if (this.orderListener) {
            this.deferCallback(() =>
              this.safeInvokeCallback("onCancel", () =>
                this.orderListener!.onCancel(makingOrder.snapshot()),
              ),
            );
          }

          // If the limit is now empty, remove it from the price tree
          if (bestLimit.isEmpty()) {
            const makingOrderBookSide = this.getBookBySide(makingOrder.side);
            makingOrderBookSide.removePriceLevel(makingOrder.price);
          }

          // OB-D3-01: the maker was removed from the book, so the depth at
          // its price and the cached BBO are now stale — every other removal
          // path marks these dirty, and the STP branch must too. Without it,
          // a pure-STP IOC (no actual trade, so createTrade's dirty-marking
          // never runs) leaves a crossed/phantom top-of-book that never
          // self-heals in a thin market.
          this.markDepthDirty(makingOrder.side, makingOrder.price);
          this.bboIsDirty = true;
          this.depthIsDirty = true;

          // Continue to next maker order at this price level
          continue;
        }

        // No self-trade - proceed with normal matching
        const matchQty = minBigInt(takingOrder.openQuantity, makingOrder.openQuantity);

        // Delegate trade creation and state updates and pass the already-found Limit object to avoid a redundant lookup
        this.createTrade(makingOrder, takingOrder, matchQty, makingOrder.price, bestLimit);
      }
    }
  }

  /**
   * Creates a trade between two orders and triggers state updates.
   * Uses object pooling for performance.
   * @param makingOrder The resting order (maker).
   * @param takingOrder The incoming order (taker).
   * @param quantity The matched quantity.
   * @param price The match price.
   * @param limit The Limit object containing the making order.
   */
  private createTrade(
    makingOrder: TOrder,
    takingOrder: TOrder,
    quantity: Quantity,
    price: Price,
    limit: Limit<TOrder>, // The Limit object is passed in directly
  ): void {
    // 1. Create the trade object from the pool.
    const trade = tradePool.get(makingOrder, takingOrder, quantity, price, this.nextTradeId++);
    // Create an immutable snapshot for external listeners
    const tradeSnapshot = trade.snapshot();

    // Collect fill for MatchingResult
    this._currentFills.push({ price: trade.matchPrice, quantity: trade.matchQuantity });

    this.metrics.tradesExecuted.add(1, { symbol: this.instrument.symbol });
    this.logger.debug("Trade executed", {
      tradeId: trade.tradeId,
      makingOrderId: trade.makingOrderId,
      takingOrderId: trade.takingOrderId,
      quantity: trade.matchQuantity.toString(),
      price: trade.matchPrice.toString(),
    });

    // 2. Atomically update (decrease) the limit's aggregate quantity by the matched amount.
    //    This is the single source of truth for the change in market depth.
    limit.updateQuantity(-quantity);

    // 3. Update the making order's state and perform O(1) removal if filled.
    //    Track cumulative fill totals for FIX CumQty-style protocol emission.
    const prevMakerCumFilled = makingOrder.cumulativeFilledQuantity;
    makingOrder.cumulativeFilledQuantity += trade.matchQuantity;
    makingOrder.cumulativeQuoteValue += trade.matchPrice * trade.matchQuantity;
    if (makingOrder.cumulativeFilledQuantity < prevMakerCumFilled) {
      throw new FatalEngineError(
        `Monotonicity violated: maker order ${makingOrder.serverOrderId} ` +
        `cumulativeFilledQuantity went from ${prevMakerCumFilled} to ${makingOrder.cumulativeFilledQuantity}`,
      );
    }
    makingOrder.decreaseQuantity(trade.matchQuantity);

    if (makingOrder.isFilled()) {
      makingOrder.state = OrderState.FILLED;
      // O(1) removal from the front of the queue.
      // We call popFront() AFTER the aggregate is updated. Since the order's
      // openQuantity is now 0, popFront's internal decrement will subtract 0,
      // preventing a double-decrement and keeping the logic clean.
      limit.popFront();
      this.orderMap.delete(makingOrder.serverOrderId!);
      // If the limit is now empty, remove it from the price tree.
      if (limit.isEmpty()) {
        const makingOrderBookSide = this.getBookBySide(makingOrder.side);
        makingOrderBookSide.removePriceLevel(makingOrder.price);
      }
    } else {
      makingOrder.state = OrderState.PARTIALLY_FILLED;
    }

    // 4. Notify about the maker fill using an immutable snapshot
    if (this.orderListener) {
      this.deferCallback(() =>
        this.safeInvokeCallback("onFill", () =>
          this.orderListener!.onFill(makingOrder.snapshot(), tradeSnapshot),
        ),
      );
    }

    // 5. Update the taking order using the generic fill method.
    this.fillOrder(takingOrder, trade);

    // 6. NOW that both orders are updated and in a consistent state, notify trade listeners.
    // This preserves the documented semantic: trade listener sees updated order state,
    // but arrives before BBO/depth updates (which occur below)
    if (this.tradeListener) {
      this.deferCallback(() =>
        this.safeInvokeCallback("onTrade", () => this.tradeListener!.onTrade(this, tradeSnapshot)),
      );
    }

    // 7. Record trade for market data (24h stats + candle engine).
    this.recordTrade(price, quantity, this.currentLogicalTs);
    this.updateCandle(price, quantity, this.currentLogicalTs);

    // 8. Mark depth dirty at the matched price level (maker side).
    this.markDepthDirty(makingOrder.side, price);

    // 9. Clean up and set flags for market data updates.
    tradePool.release(trade);
    this.bboIsDirty = true;
    this.depthIsDirty = true;
  }

  /**
   * Updates an order’s state after a trade.
   * This is used for the taking order. The making order's fill logic
   * is optimized and handled directly in `createTrade`.
   * @param order The order to update.
   * @param trade The trade details.
   */
  private fillOrder(order: TOrder, trade: Trade): void {
    // Track cumulative fill totals for FIX CumQty-style protocol emission.
    const prevCumFilled = order.cumulativeFilledQuantity;
    order.cumulativeFilledQuantity += trade.matchQuantity;
    order.cumulativeQuoteValue += trade.matchPrice * trade.matchQuantity;
    if (order.cumulativeFilledQuantity < prevCumFilled) {
      throw new FatalEngineError(
        `Monotonicity violated: taker order ${order.serverOrderId} ` +
        `cumulativeFilledQuantity went from ${prevCumFilled} to ${order.cumulativeFilledQuantity}`,
      );
    }
    // Decrease order quantity
    order.decreaseQuantity(trade.matchQuantity);

    // Update state based on fill status
    if (order.isFilled()) {
      order.state = OrderState.FILLED;
      // For a taking order, this correctly removes it from the orderMap.
      this.removeOrderFromBook(order);
    } else {
      order.state = OrderState.PARTIALLY_FILLED;
    }

    // Notify listeners after state is consistent
    const orderSnapshot = order.snapshot();
    // CRITICAL: capture trade snapshot EAGERLY (not inside the deferred
    // callback). `tradePool.release(trade)` runs in createTrade right after
    // fillOrder returns, resetting trade.matchPrice / matchQuantity to 0n.
    // If we called `trade.snapshot()` lazily inside the closure below, the
    // deferred callback would fire AFTER the release and snapshot a
    // zeroed object — propagating matchPrice=0 / matchQuantity=0 to the
    // taker's onFill listener (and from there to wsBalance, which would
    // compute cost=0 and leave the WS-broadcast balance unchanged).
    // The maker side at line ~1363 already does it this way (cached
    // `tradeSnapshot` from createTrade). This mirrors that pattern.
    const tradeSnapshot = trade.snapshot();
    if (this.orderListener) {
      this.deferCallback(() =>
        this.safeInvokeCallback("onFill", () =>
          this.orderListener!.onFill(orderSnapshot, tradeSnapshot),
        ),
      );
    }
  }

  /**
   * Validates an order’s parameters.
   * @param order The order to validate.
   * @throws OrderBookError if invalid.
   */
  private validateOrder(order: TOrder): void {
    // 1. Side must be BUY or SELL
    if (order.side !== Side.BUY && order.side !== Side.SELL) {
      throw new OrderBookError(OrderRejectReason.Other, `Invalid side: ${order.side}`);
    }

    // Note: quantity > 0 is enforced by the Order constructor (programmer-
    // error invariant), so no quantity check is needed here.

    // 2. Check tick size alignment only for limit orders. Market orders don't have a price to check.
    // The tickSize itself is a scaled integer. The price must be a multiple of it.
    // (Price positivity needs no separate check: isLimit() is defined as
    // price > 0n, and the Order constructor rejects negative prices.)
    if (order.isLimit()) {
      if (order.price % BigInt(this.instrument.tickSize) !== 0n) {
        // Use the formatter to create a human-readable error message
        const displayTickSize = this.fromInternalPrice(BigInt(this.instrument.tickSize));
        throw new OrderBookError(
          OrderRejectReason.InvalidTickSize,
          `Price must be a multiple of the tick size (${displayTickSize})`,
        );
      }

      // 3. Enforce the instrument's price bounds. These fields are documented as
      // enforced (instrument.ts minPrice/maxPrice) but were never checked here —
      // a tick-aligned price of any magnitude (e.g. 10^30) rested unbounded,
      // which is both a false guarantee and a BigInt limb-growth surface. In
      // prod minPrice = tickSize and maxPrice = the system ceiling, so this only
      // rejects absurd/out-of-range prices; per-market overrides now take effect.
      this.assertPriceInBounds(order.price);
    }
  }

  /**
   * Rejects a limit price outside the instrument's [minPrice, maxPrice] range.
   * Bounds are inclusive. Shared by validateOrder and validateReplace.
   *
   * ⚠️ AMM COUPLING: the AMM floors its bid quotes at `tickSize`, and is never
   * given `minPrice` (see packages/amm — it receives tickSize + maxPrice only).
   * That is safe TODAY solely because every production instrument has
   * `minPrice === tickSize` (engine.ts derives `minPriceStr = tickSizeStr`). If a
   * market is ever configured with `minPrice > tickSize`, the AMM would quote
   * bids below minPrice and they would be rejected here — a one-sided AMM outage
   * (the #612 failure mode). Before enabling `minPrice > tickSize` anywhere,
   * plumb `minPrice` into the AMM bid floor (or assert minPrice===tickSize at
   * instrument construction to fail loud).
   */
  private assertPriceInBounds(price: Price): void {
    if (price < this.instrument.minPrice || price > this.instrument.maxPrice) {
      throw new OrderBookError(
        OrderRejectReason.InvalidPrice,
        `Price ${this.fromInternalPrice(price)} is outside the instrument's valid range ` +
          `[${this.fromInternalPrice(this.instrument.minPrice)}, ` +
          `${this.fromInternalPrice(this.instrument.maxPrice)}]`,
      );
    }
  }

  private validateReplace(order: TOrder, newQuantity: Quantity, newPrice: Price): void {
    // Reject if no changes requested
    if (newQuantity === order.orderQuantity && newPrice === order.price) {
      throw new OrderBookError(
        OrderRejectReason.NoChange,
        getOrderRejectReasonText(OrderRejectReason.NoChange),
      );
    }

    // Validate new quantity
    if (newQuantity <= 0n) {
      throw new OrderBookError(
        OrderRejectReason.QtyMustBePositive,
        getOrderRejectReasonText(OrderRejectReason.QtyMustBePositive),
      );
    }

    // Symmetry with add() (see the MAX_QUANTITY_VALUE guard on the add path):
    // reject an out-of-range magnitude. add() enforces this both as a range
    // invariant and as a BigInt limb-growth guard; replace() must not be a back
    // door around it, resting an order at a quantity the engine declares impossible.
    if (newQuantity > MAX_QUANTITY_VALUE) {
      throw new OrderBookError(
        OrderRejectReason.IncorrectQuantity,
        "Quantity exceeds system maximum",
      );
    }

    // Enforce filled-qty floor
    const filledQuantity = order.orderQuantity - order.openQuantity;
    if (newQuantity < filledQuantity) {
      throw new OrderBookError(
        OrderRejectReason.QtyLessThanFilled,
        `filled: ${filledQuantity}, requested: ${newQuantity}`,
      );
    }

    // A market order cannot be replaced into a limit order, and vice-versa.
    // This logic assumes the order type is immutable. If the original order was a limit order,
    // the new price must also be a valid limit price (> 0).
    if (order.isLimit()) {
      if (newPrice === 0n) {
        throw new OrderBookError(
          OrderRejectReason.InvalidPrice,
          "Price must be positive for limit orders",
        );
      }
      if (newPrice % BigInt(this.instrument.tickSize) !== 0n) {
        const displayTickSize = this.fromInternalPrice(BigInt(this.instrument.tickSize));
        throw new OrderBookError(
          OrderRejectReason.InvalidTickSize,
          `Price must be a multiple of the tick size (${displayTickSize})`,
        );
      }
      // Enforce instrument price bounds on the new price too (symmetry with add).
      this.assertPriceInBounds(newPrice);
    }
    // If the original order was a market order, its price is 0. A replace request
    // should not be able to change it to a limit order.
    if (order.isMarket() && newPrice !== 0n) {
      throw new OrderBookError(
        OrderRejectReason.InvalidPrice,
        "Cannot change a market order to a limit order via replace.",
      );
    }
  }

  /**
   * Builds a MatchingResult from the order's FINAL state after matching.
   *
   * Status derives from `order.state` — NOT from `fills.length`. The previous
   * fills-based derivation reported "RESTING" for a zero-fill IOC whose
   * residual `_processOrder` had just CANCELED and deleted from the orderMap
   * (user-facing: "resting on book" UX for an order that no longer exists),
   * and "FILLED" for a partial IOC with a canceled residual.
   *
   * After `_processOrder` the only reachable states here are:
   *   FILLED            → fully executed
   *   CANCELED          → IOC residual canceled (order removed from the book)
   *   NEW / PARTIALLY_FILLED → resting on the book
   */
  private buildMatchingResult(
    order: TOrder,
    fills: ReadonlyArray<{ price: Price; quantity: Quantity }>,
  ): MatchingResult {
    const serverOrderId = order.serverOrderId!.toString();

    const status: MatchingResult["status"] =
      order.state === OrderState.FILLED
        ? "FILLED"
        : order.state === OrderState.CANCELED
          ? "CANCELED"
          : "RESTING";

    return {
      status,
      serverOrderId,
      fills,
      remainingQuantity: order.openQuantity,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // MARKET DATA METHODS
  // ─────────────────────────────────────────────────────────────

  /** Record a trade for rolling 24h statistics. */
  private recordTrade(price: Price, qty: Quantity, ts: number): void {
    this.lastTradePrice = price;
    this.advanceBuckets();
    const hourIdx = Math.floor(ts / 3600000) % 24;
    this.volumeBuckets[hourIdx] += qty;
    this.tradeCountBuckets[hourIdx]++;
  }

  /** Lazy bucket eviction — zeroes out stale hourly buckets. */
  private advanceBuckets(): void {
    const currentHour = Math.floor(this.currentLogicalTs / 3600000);
    if (currentHour > this.lastUpdateHour) {
      const hoursElapsed = currentHour - this.lastUpdateHour;
      if (hoursElapsed >= 24) {
        this.volumeBuckets.fill(0n);
        this.tradeCountBuckets.fill(0);
      } else {
        for (let i = 1; i <= hoursElapsed; i++) {
          const idx = (this.lastUpdateHour + i) % 24;
          this.volumeBuckets[idx] = 0n;
          this.tradeCountBuckets[idx] = 0;
        }
      }
      this.lastUpdateHour = currentHour;
    }
  }

  /** Get rolling 24h volume and trade count. */
  public getStats24h(): { volume24h: bigint; tradeCount24h: number; lastPrice: Price | null } {
    this.advanceBuckets();
    let volume24h = 0n;
    let tradeCount24h = 0;
    for (let i = 0; i < 24; i++) {
      volume24h += this.volumeBuckets[i];
      tradeCount24h += this.tradeCountBuckets[i];
    }
    return { volume24h, tradeCount24h, lastPrice: this.lastTradePrice };
  }

  /** Seed a single hourly bucket during startup rehydration. */
  public seedHistoricalVolume(bucketIndex: number, volume: bigint, count: number): void {
    // Bound the index: the 24h ticker is a fixed 24-slot ring. An out-of-range
    // index would grow volumeBuckets past 24, and exportSnapshot then carries a
    // length!==24 array — which importSnapshot silently resets to all-zero,
    // discarding legitimate seeded data too. Fail loud instead.
    if (!Number.isInteger(bucketIndex) || bucketIndex < 0 || bucketIndex >= 24) {
      throw new OrderBookError(
        OrderRejectReason.Other,
        `seedHistoricalVolume: bucketIndex ${bucketIndex} out of range [0, 24)`,
      );
    }
    this.volumeBuckets[bucketIndex] = volume;
    this.tradeCountBuckets[bucketIndex] = count;
  }

  /** Mark a price level as dirty for depth delta tracking. */
  public markDepthDirty(side: Side, price: Price): void {
    if (side === Side.BUY) this.dirtyBids.add(price);
    else this.dirtyAsks.add(price);
  }

  /** Safe level quantity lookup for depth deltas. */
  public getLevelQty(price: Price, side: Side): Quantity {
    const tree = side === Side.BUY ? this.bids : this.asks;
    const level = tree.get(price);
    return level ? level.totalQuantity : 0n;
  }

  /** Extract only changed price levels since last flush, then clear dirty sets. */
  public getDepthDeltas(): { bids: DepthDelta[]; asks: DepthDelta[] } {
    const bids: DepthDelta[] = [];
    const asks: DepthDelta[] = [];
    for (const price of this.dirtyBids) {
      bids.push({ price, quantity: this.getLevelQty(price, Side.BUY) });
    }
    for (const price of this.dirtyAsks) {
      asks.push({ price, quantity: this.getLevelQty(price, Side.SELL) });
    }
    this.dirtyBids.clear();
    this.dirtyAsks.clear();
    return { bids, asks };
  }

  /** Update or create candle; close previous candle on minute boundary crossing. */
  private updateCandle(price: Price, qty: Quantity, ts: number): void {
    const tradeMinute = Math.floor(ts / 60000) * 60000;

    // Close previous candle if we crossed a minute boundary
    if (this.currentCandle && tradeMinute > this.currentCandle.startMinute) {
      // Capture the closed candle eagerly, then dispatch via the SAME
      // deferred + guarded path as every other listener (onFill/onTrade/etc).
      // updateCandle runs inside createTrade, mid match-loop — a raw
      // synchronous call here let a throwing onCandleClosed abort matching,
      // stranding a partially-filled, uncancellable taker in orderMap. The
      // eager capture is required because currentCandle is nulled below before
      // the deferred callback fires.
      const closedCandle: Candle = {
        ...this.currentCandle,
        closeTime: this.currentCandle.startMinute + 60000,
      };
      this.currentCandle = null;
      const listener = this.tradeListener;
      if (listener?.onCandleClosed) {
        this.deferCallback(() =>
          this.safeInvokeCallback("onCandleClosed", () =>
            listener.onCandleClosed!(this, closedCandle),
          ),
        );
      }
    }

    // Create new candle or update existing
    if (!this.currentCandle) {
      this.currentCandle = {
        open: price, high: price, low: price, close: price,
        volume: qty, startMinute: tradeMinute,
      };
    } else {
      if (price > this.currentCandle.high) this.currentCandle.high = price;
      if (price < this.currentCandle.low) this.currentCandle.low = price;
      this.currentCandle.close = price;
      this.currentCandle.volume += qty;
    }
  }

  /**
   * Dispatches BBO and depth updates if needed.
   */
  private dispatchNotifications(): void {
    if (this.bboIsDirty) this.updateBbo();
    if (this.depthIsDirty) {
      this.depthSeq++;
      this.updateDepth();
    }
  }

  /**
   * Removes an order from the book and orderMap.
   * Single source of truth for order removal.
   * @param order The order to remove.
   * @returns True if removed, false otherwise.
   */
  private removeOrderFromBook(order: TOrder): boolean {
    const book = this.getBookBySide(order.side);

    // Try to remove from book (handles Limit and orderMap cleanup)
    if (book.remove(order)) {
      this.orderMap.delete(order.serverOrderId!);
      return true;
    }

    // Handle taking orders that were never in book
    if (order.isFilled()) {
      this.orderMap.delete(order.serverOrderId!);
      return true;
    }

    // Structured log: message + context
    this.logger.warn("Order missing from book during removal", {
      orderId: order.orderId,
      serverOrderId: order.serverOrderId,
      side: Side[order.side], // Use string name for readability
      price: order.price.toString(),
      openQuantity: order.openQuantity.toString(),
      state: OrderState[order.state],
    });

    return false;
  }

  /**
   * INVARIANT ENFORCEMENT (Post-WAL Replay)
   *
   * Fail-fast if replay produced any latent corruption.
   * This runs ONCE at startup and is NOT performance sensitive.
   */
  private assertPostReplayInvariants(): void {
    // Use the existing forward() iterator on your OrderMultiMap
    const trees = [this.bids, this.asks];

    for (const tree of trees) {
      // .forward() yields Limit<TOrder> objects
      for (const limit of tree.forward()) {
        let computedQty = 0n;
        let computedCount = 0;

        // Use the public @internal pointers we defined in Order
        let prev: TOrder | null = null;
        let current = (limit as any).head as TOrder | null; // Cast head access

        while (current !== null) {
          // ───────────────────────────────────────────
          // Invariant 1: Ownership consistency
          // ───────────────────────────────────────────
          if (current._limit !== (limit as any)) {
            throw new FatalEngineError(
              `RECOVERY FAILURE: Order ${current.orderId} claims wrong Limit.`,
            );
          }

          // ───────────────────────────────────────────
          // Invariant 2: Doubly-linked list integrity
          // ───────────────────────────────────────────
          if (current._prev !== prev) {
            throw new FatalEngineError(
              `DURABILITY CRITICAL: DLL prev pointer corruption after replayat Order ${current.orderId}.`,
            );
          }

          // ───────────────────────────────────────────
          // Invariant 3: No self-cycles
          // ───────────────────────────────────────────
          if (current._next === current) {
            throw new FatalEngineError(
              `DURABILITY CRITICAL: Cyclic pointer detected at Order ${current.orderId}.`,
            );
          }

          computedQty += current.openQuantity;
          computedCount++;

          prev = current;
          current = current._next as TOrder | null;
        }

        // ───────────────────────────────────────────
        // Invariant 4: Head / tail correctness
        // ───────────────────────────────────────────
        if ((limit as any).tail !== prev) {
          throw new FatalEngineError("DURABILITY CRITICAL: Limit tail mismatch after replay");
        }

        // ───────────────────────────────────────────
        // Invariant 5: Aggregate correctness
        // ───────────────────────────────────────────
        if (limit.totalQuantity !== computedQty) {
          throw new FatalEngineError(
            `DURABILITY CRITICAL: Quantity drift after replay (expected ${computedQty}, got ${limit.totalQuantity})`,
          );
        }

        if (limit.orderCount !== computedCount) {
          throw new FatalEngineError(
            `DURABILITY CRITICAL: Order count drift after replay (expected ${computedCount}, got ${limit.orderCount})`,
          );
        }
      }
    }

    // ───────────────────────────────────────────
    // Invariant 6: Bi-directional reachability
    // Every live order in orderMap MUST be linked to a Limit.
    // Catches ghost orders (in map but detached from book).
    // ───────────────────────────────────────────
    for (const [sid, order] of this.orderMap.entries()) {
      if (order.state === OrderState.NEW || order.state === OrderState.PARTIALLY_FILLED) {
        if (order._limit === null) {
          throw new FatalEngineError(
            `DURABILITY CRITICAL: Order ${sid} (orderId=${order.orderId}) in orderMap but detached from Limit. Ghost order detected.`,
          );
        }
      }
    }
  }

  /**
   * Post-recovery invariant verification hook.
   *
   * NOTE ON THE async SIGNATURE: this method does NO I/O today — it only runs
   * the synchronous `assertPostReplayInvariants()` pass. The `Promise<void>`
   * return is a forward-compatible seam for a future host that streams WAL
   * replay here, so callers already `await` it. It is called ONCE at startup,
   * BEFORE the book accepts live commands — never interleaved with add/cancel/
   * replace — so there is no async-reentrancy hazard. Do NOT introduce awaited
   * work here that could overlap a mutation without first adding a guard.
   */
  public async recover(): Promise<void> {
    // ... WAL Replay Logic ...
    this.assertPostReplayInvariants();
    this.logger.info("OrderBook recovered and verified.");
  }

  /**
   * Updates the Best Bid and Offer (BBO).
   * Notifies listeners only if changed.
   */
  private updateBbo(): void {
    // Get best bid (highest) and ask (lowest)
    const bestAskLimit = this.asks.getBest();
    const bestBidLimit = this.bids.getBestReverse();

    const newBidPrice = bestBidLimit?.price ?? 0n;
    const newBidQuantity = bestBidLimit?.totalQuantity ?? 0n;
    const newAskPrice = bestAskLimit?.price ?? 0n;
    const newAskQuantity = bestAskLimit?.totalQuantity ?? 0n;

    const current = this.bboBuffers[this.bboIndex];

    // Only notify if BBO actually changed
    if (
      newBidPrice !== current.bidPrice ||
      newBidQuantity !== current.bidQuantity ||
      newAskPrice !== current.askPrice ||
      newAskQuantity !== current.askQuantity
    ) {
      // Write to the NEXT buffer, then flip — this is the atomic swap.
      // Listeners see a consistent snapshot; the previous buffer is untouched
      // until the next update cycle.
      const nextIndex = this.bboIndex ^ 1;
      const next = this.bboBuffers[nextIndex];
      next.bidPrice = newBidPrice;
      next.bidQuantity = newBidQuantity;
      next.askPrice = newAskPrice;
      next.askQuantity = newAskQuantity;

      this.bboIndex = nextIndex; // Atomic swap
      this.bboLastUpdateTs = this.currentLogicalTs;

      if (this.bboListener) {
        // Guarded but NOT deferred: the BBO double-buffer contract requires
        // synchronous consumption (the buffer is reused on the next update), so
        // deferring would hand the listener a stale/overwritten buffer. We keep
        // the call inline but wrap it so a throwing or reentrant listener cannot
        // abort the in-flight operation — which previously propagated out of
        // dispatchNotifications and mislabeled an already-rested order REJECTED
        // (a reentrant call trips guardReentrancy → OrderBookError, now
        // swallowed+logged here instead of corrupting state).
        const listener = this.bboListener;
        const bbo = next;
        this.safeInvokeCallback("onBboChange", () => listener.onBboChange(this, bbo));
      }
    }
    this.bboIsDirty = false;
  }

  /**
   * Returns the current BBO state with the timestamp of the last mutation.
   * Used by the Hot Layer snapshot endpoint to serve BBO from engine RAM.
   */
  public getBbo(): Bbo & { lastUpdateTs: number } {
    const current = this.bboBuffers[this.bboIndex];
    return {
      bidPrice: current.bidPrice,
      bidQuantity: current.bidQuantity,
      askPrice: current.askPrice,
      askQuantity: current.askQuantity,
      lastUpdateTs: this.bboLastUpdateTs,
    };
  }

  /**
   * Updates the order book depth and fires the depth listener if registered.
   * The full rebuild is lazy — only performed when a listener is attached
   * (notifyDepthListener gates on listener-ness) or when getDepth() is
   * called while dirty. Without a listener, mutations only set the dirty
   * flag here — no rebuild work happens on the hot path.
   */
  private updateDepth(): void {
    this.depthIsDirty = true;
    // Fire depth listener (rebuilds snapshot only if listener exists)
    this.notifyDepthListener();
  }

  /**
   * Rebuilds the depth snapshot on-demand and clears the dirty flag.
   * Called by getDepth() or just before listener notification.
   * Unconditional — listener gating lives in notifyDepthListener(), NOT
   * here. (An earlier version early-returned when no listener was attached
   * while still clearing depthIsDirty, which made the public getDepth()
   * permanently return a never-rebuilt snapshot on listener-less books.)
   */
  private rebuildDepth(): void {
    // Clear existing depth before rebuilding.
    this.depth.clear();

    // Add bid levels (descending price) from the aggregate totals.
    for (const limit of this.bids.backward()) {
      // Defensively check for quantity, ensuring no zero-levels are published.
      if (limit.totalQuantity > 0n) {
        this.depth.addBidLevel({
          price: limit.price,
          quantity: limit.totalQuantity,
          orderCount: limit.orderCount,
        });
      }
    }

    // Add ask levels (ascending price) from the aggregate totals.
    for (const limit of this.asks.forward()) {
      // Defensively check for quantity.
      if (limit.totalQuantity > 0n) {
        this.depth.addAskLevel({
          price: limit.price,
          quantity: limit.totalQuantity,
          orderCount: limit.orderCount,
        });
      }
    }

    // Set the timestamp to the current time in milliseconds just before dispatching.
    // This marks the precise moment this snapshot was generated.
    this.depth.lastChange = this.currentLogicalTs;

    this.depthIsDirty = false;
  }

  /**
   * Public API: Get current depth snapshot (triggers rebuild if dirty).
   */
  public getDepth(): Depth {
    if (this.depthIsDirty) {
      this.rebuildDepth();
    }
    return this.depth.shallowClone();
  }

  /**
   * Notify depth listener with fresh snapshot.
   */
  private notifyDepthListener(): void {
    if (this.depthListener && this.depthIsDirty) {
      this.rebuildDepth();
      // Clone only when actually notifying. Guarded (synchronous — the clone is
      // already a defensive copy, so no double-buffer hazard) so a throwing or
      // reentrant depth listener can't abort the in-flight operation.
      const listener = this.depthListener;
      const snapshot = this.depth.shallowClone();
      this.safeInvokeCallback("onDepthChange", () => listener.onDepthChange(this, snapshot));
    }
  }

  /**
   * Retrieves a read-only reference to an order from the book's master list.
   * This is used by higher-level components for authorization and status checks.
   * @param orderSid The server-side ID of the order to retrieve.
   * @returns The order object, or undefined if not found.
   */
  public getOrder(orderSid: OrderSid): TOrder | undefined {
    return this.orderMap.get(orderSid);
  }

  /**
   * The lowest resting ask price, or `0n` if the ask side is empty.
   * O(1) — reads the head of the ask tree.
   */
  public getBestAskPrice(): Price {
    return this.asks.getBest()?.price ?? 0n;
  }

  /**
   * The highest resting bid price, or `0n` if the bid side is empty.
   * O(1) — reads the tail of the bid tree.
   */
  public getBestBidPrice(): Price {
    return this.bids.getBestReverse()?.price ?? 0n;
  }

  /**
   * Converts display price to internal scaled integer.
   * Delegates to pure function in math.ts for reusability across frontend/engine.
   */
  public toInternalPrice(displayPrice: number | string): Price {
    return toInternalPrice(displayPrice, this.instrument.pricePrecision);
  }

  /**
   * Converts internal price to display format.
   * Delegates to pure function in math.ts for reusability across frontend/engine.
   */
  public fromInternalPrice(internalPrice: Price): string {
    return fromInternalPrice(internalPrice, this.instrument.pricePrecision);
  }

  /**
   * Converts display quantity to internal scaled integer.
   * Delegates to pure function in math.ts for reusability across frontend/engine.
   */
  public toInternalQuantity(displayQuantity: number | string): Quantity {
    return toInternalQuantity(displayQuantity, this.instrument.quantityPrecision);
  }

  /**
   * Converts internal quantity to display format.
   * Delegates to pure function in math.ts for reusability across frontend/engine.
   */
  public fromInternalQuantity(internalQuantity: Quantity): string {
    return fromInternalQuantity(internalQuantity, this.instrument.quantityPrecision);
  }
}
