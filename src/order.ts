// packages/orderbook/src/order.ts

import { CURRENT_SCHEMA_VERSION } from "./constants";
import { FatalEngineError } from "./errors";
import { toBoundedBigInt } from "./serialization";
// Type-only import to avoid circular dependency at runtime
import type { Limit } from "./limit";
import type { LimitOwnerBrand } from "./types";
import { OrderId, OrderSid, Price, Quantity, Side } from "./types";

/**
 * Order lifecycle states, modeled on FIX 5.0 SP2 `OrdStatus` (tag 39).
 * See the {@link OrderBook} class doc for the full FIX mapping table.
 */
export enum OrderState {
  /**
   * Received but not yet accepted for execution (not yet in book).
   * FIX: an execution message with this status is only sent in response to an
   * OrderStatusRequest(35=H).
   */
  PENDING_NEW,
  /**
   * Rejected by the book. NOTE: an order can be rejected subsequent to order
   * acknowledgment, i.e. it can pass from NEW to REJECTED.
   */
  REJECTED,
  /** Outstanding order with no executions. */
  NEW,
  /** Outstanding order with executions and remaining quantity. */
  PARTIALLY_FILLED,
  /** Completely filled — no remaining quantity. */
  FILLED,
  /** Canceled, with or without executions. */
  CANCELED,
  /**
   * A replace request is pending (confirms receipt of an
   * OrderCancelReplaceRequest(35=G)). Does NOT indicate the order has been
   * replaced.
   */
  PENDING_REPLACE,
  /**
   * A cancel request is pending (confirms receipt of an
   * OrderCancelRequest(35=F)). Does NOT indicate the order has been canceled.
   */
  PENDING_CANCEL,
}

/**
 * Public, immutable snapshot of an Order passed to external listeners.
 * Keep this flat and serializable — no methods.
 *
 * v3.5 ENHANCEMENTS:
 * - schemaVersion: For WAL/snapshot durability
 * - isProtectedMarket: For market order protection feature
 */
export interface OrderSnapshot<TUserData = unknown> {
  readonly schemaVersion: number; // WAL/snapshot durability versioning
  readonly orderId: OrderId;
  readonly serverOrderId: OrderSid | null;
  readonly side: Side;
  readonly price: Price;
  readonly orderQuantity: Quantity;
  readonly openQuantity: Quantity;
  readonly state: OrderState;
  readonly userData: TUserData | null;
  readonly isProtectedMarket: boolean; // market order protection (IOC with price cap)
  // #398: IOC time-in-force. Optional — absent in pre-#398 snapshots; restored
  // as false (GTC). Safe because IOC orders never rest, so a restored resting
  // order is always GTC. No schemaVersion bump (additive, default-false).
  readonly ioc?: boolean;
  // FIX CumQty-style cumulative fill tracking (monotonically non-decreasing)
  readonly cumulativeFilledQuantity: Quantity;
  readonly cumulativeQuoteValue: bigint; // Σ(matchPrice × matchQuantity)
  readonly reservedAmount?: bigint;
  readonly releasedAmount?: bigint;
}

/**
 * JSON-safe wire/durability shape of an Order — exactly what
 * `Order.toSerializableObject()` emits and what `deserializeOrder()` accepts
 * (WAL records, book snapshots). Every BigInt field of `OrderSnapshot` is
 * encoded as a decimal string; all other fields pass through unchanged.
 *
 * Field optionality encodes READ-side compatibility: the write side always
 * emits every field present on `OrderSnapshot`, but `deserializeOrder` must
 * tolerate older on-disk data that predates a field (it restores documented
 * defaults). Fields that have always existed are required.
 *
 * This is a compile-time contract only — it does not change the wire format.
 */
export interface SerializedOrder {
  schemaVersion: number;
  orderId: OrderId;
  /** OrderSid (bigint) as decimal string; null if never assigned. */
  serverOrderId: string | null;
  side: Side;
  /** Price (bigint) as decimal string ("0" for pure market orders). */
  price: string;
  orderQuantity: string;
  openQuantity: string;
  state: OrderState;
  /**
   * Passed through BY REFERENCE, not transformed — the engine-layer
   * userData is plain JSON-safe data by contract (identity + static
   * metadata, no BigInt fields).
   */
  userData: unknown;
  isProtectedMarket: boolean;
  /** #398 additive — absent in pre-#398 data; restored as false (GTC). */
  ioc?: boolean;
  /** Absent in pre-CumQty data; restored as 0n. */
  cumulativeFilledQuantity?: string;
  /** Absent in pre-CumQty data; restored as 0n. */
  cumulativeQuoteValue?: string;
  /** Absent in pre-reservation-accounting data; restored as 0n. */
  reservedAmount?: string;
  /** Absent in pre-reservation-accounting data; restored as 0n. */
  releasedAmount?: string;
}

/**
 * Represents a single order. It is a pure data container for the matching engine,
 * agnostic of the symbol it belongs to. Application-level context is attached
 * via the generic TUserData property.
 *
 * This class encapsulates all the data and behavior for a trading order,
 * including its lifecycle management and quantity tracking.
 *
 * @template TUserData The type for custom, user-defined data attached to the order.
 *                     Defaults to `unknown` for type safety.
 *
 * @example
 * ```typescript
 * interface MyOrderData {
 *   userId: string;
 *   strategy: string;
 * }
 *
 * const order = new Order<MyOrderData>(
 *   "client-123",
 *   Side.BUY,
 *   toPrice(100.50),
 *   toQuantity(100),
 *   { userId: "user123", strategy: "momentum" }
 * );
 * ```
 */
export class Order<TUserData = unknown> {
  // ═══════════════════════════════════════════════════════════════════════════
  // INTRUSIVE LINKED-LIST POINTERS (Internal use only)
  // These enable O(1) removal from Limit queues without Denque iteration.
  //
  // CRITICAL: These are `public` with `@internal` JSDoc (NOT `private`).
  // This enables V8 JIT optimization via direct offset-based memory access.
  // Using `private` would require getters or `as any` casts, both slower.
  //
  // IMPORTANT: Properly typed (not `unknown`) to enable V8 hidden class
  // optimization via consistent object shapes.
  //
  // INVARIANT: An Order can only belong to ONE Limit at a time.
  //            _limit !== null means the order is currently enqueued.
  // ═══════════════════════════════════════════════════════════════════════════

  /** @internal Previous order in queue (null if head). DO NOT access externally. */
  public _prev: Order<TUserData> | null = null;

  /** @internal Next order in queue (null if tail). DO NOT access externally. */
  public _next: Order<TUserData> | null = null;

  /** @internal Reference to containing Limit (O(1) ownership proof). DO NOT access externally. */
  public _limit: (Limit<Order<TUserData>> & LimitOwnerBrand) | null = null;

  // ═══════════════════════════════════════════════════════════════════════════

  // These properties should never change after creation.
  public readonly orderId: OrderId;
  public readonly side: Side;

  // These properties can be modified by the OrderBook during a 'replace' operation.
  public price: Price;
  public orderQuantity: Quantity;

  // Properties that change during the order's lifecycle
  public openQuantity: Quantity;
  public serverOrderId: OrderSid | null = null;

  public state: OrderState = OrderState.PENDING_NEW;

  // userData is a generic type for Userdata, defaulting to `unknown` for maximum safety.
  public userData: TUserData | null = null;

  // Schema version for WAL/snapshot durability
  // CRITICAL: Prevents silent downgrade of protected orders on crash recovery
  // If this is missing during deserialization, the engine MUST throw FatalEngineError
  public readonly schemaVersion: number = 1;

  // Flag for Market-to-Limit transformed orders (IOC behavior with price cap)
  // CRITICAL: Must be serialized and restored on crash recovery
  public isProtectedMarket: boolean = false;

  // Time-in-force IOC flag for a priced (LIMIT) order — set from
  // AddOrderCommand.timeInForce (#398). A marketable-limit IOC fills up to its
  // price cap then has its residual canceled (never rests). Default false (GTC).
  // IOC orders never rest, so this is irrelevant for restored resting orders —
  // but it is copied in clone() because the Step-2 sandbox matches a live IOC
  // order mid-command, where the residual-cancel decision depends on it.
  public ioc: boolean = false;

  // FIX CumQty-style fill tracking — monotonically non-decreasing.
  // Incremented on every fill BEFORE snapshot() is called.
  // Used by the worker to derive absolute fill state without delta accumulation.
  public cumulativeFilledQuantity: Quantity = 0n;
  public cumulativeQuoteValue: bigint = 0n; // Σ(matchPrice × matchQuantity)

  // Reservation accounting (balance precision). Passive serialization state —
  // does NOT influence matching. Persisted in snapshots for exact restoration
  // without recomputation drift. See docs/bugs/solvency-drift-970M.md.
  public reservedAmount: bigint = 0n;  // set by SimpleExchange.handleSubmitOrder
  public releasedAmount: bigint = 0n;  // incremented by onFill per-fill releases

  /**
   * Creates a new Order instance.
   *
   * Note: This constructor enforces critical invariants. It will throw a standard `Error`
   * if constructed with invalid parameters (e.g., zero or negative quantity), as this
   * is considered a programmer error, not a runtime rejection.
   */
  constructor(
    orderId: OrderId,
    side: Side,
    price: Price,
    quantity: Quantity,
    userData?: TUserData,
  ) {
    if (!orderId?.trim()) {
      throw new Error("Invariant violation: Order ID cannot be null or empty.");
    }
    if (side !== Side.BUY && side !== Side.SELL) {
      throw new Error(`Invariant violation: Invalid side specified: ${side}.`);
    }
    if (price < 0n) {
      throw new Error(`Invariant violation: Price cannot be negative. Received: ${price}`);
    }
    if (quantity <= 0n) {
      throw new Error(`Invariant violation: Quantity must be positive. Received: ${quantity}`);
    }

    this.orderId = orderId;
    this.side = side;
    this.price = price;
    this.orderQuantity = quantity;
    this.openQuantity = quantity;
    this.userData = userData ?? null;
  }

  /**
   * Decreases the open quantity of the order by the specified amount.
   * Ensures the open quantity never goes below zero.
   *
   * @param quantityToDecrease - The amount to decrease the open quantity by
   *
   * @example
   * ```typescript
   * const order = new Order("123", Side.BUY, 100, 1000);
   * order.decreaseQuantity(300); // openQuantity becomes 700
   * order.decreaseQuantity(800); // openQuantity becomes 0 (clamped)
   * ```
   */
  public decreaseQuantity(quantityToDecrease: Quantity): void {
    // A negative decrease is a programming error — reject loudly.
    if (quantityToDecrease < 0n) {
      throw new Error("Quantity to decrease cannot be negative.");
    }

    if (quantityToDecrease > this.openQuantity) {
      this.openQuantity = 0n;
    } else {
      this.openQuantity -= quantityToDecrease;
    }
  }

  /**
   * Checks if the order is completely filled (no remaining open quantity).
   *
   * @returns True if the order is completely filled, false otherwise
   *
   * @example
   * ```typescript
   * const order = new Order("123", Side.BUY, 100, 1000);
   * console.log(order.isFilled()); // false
   * order.decreaseQuantity(1000);
   * console.log(order.isFilled()); // true
   * ```
   */
  public isFilled(): boolean {
    return this.openQuantity === 0n;
  }

  /**
   * Checks if this is a limit order (has a specific price).
   * Market orders would have a price of 0.
   *
   * @returns True if this is a limit order, false if it's a market order
   *
   * @example
   * ```typescript
   * const limitOrder = new Order("123", Side.BUY, 100, 1000);
   * const marketOrder = new Order("124", Side.BUY, 0, 1000);
   * console.log(limitOrder.isLimit()); // true
   * console.log(marketOrder.isLimit()); // false
   * ```
   */
  public isLimit(): boolean {
    return this.price > 0n;
  }

  /**
   * Checks if the order is a market order.
   * By convention, market orders have a price of 0.
   *
   * CRITICAL: Protected market orders have price > 0, so this returns false.
   * This ensures the matching engine respects their price cap.
   *
   * @returns {boolean} True if pure market order, false otherwise.
   */
  public isMarket(): boolean {
    return this.price === 0n;
  }

  /**
   * Checks if the order requires Immediate-or-Cancel behavior.
   * Includes both pure market orders and protected market orders.
   *
   * Used by OrderBook to determine if unfilled quantity should be
   * automatically canceled after matching attempt.
   *
   * @returns {boolean} True if IOC behavior required, false otherwise.
   */
  public isIOC(): boolean {
    return this.isMarket() || this.isProtectedMarket || this.ioc;
  }

  /**
   * Create a minimal, immutable snapshot of the order for external listeners.
   * This prevents external code from mutating internal order state and
   * protects the matching engine from reentrancy mutations.
   */
  public snapshot(): OrderSnapshot<TUserData> {
    return {
      schemaVersion: this.schemaVersion, // WAL/snapshot durability versioning
      orderId: this.orderId,
      serverOrderId: this.serverOrderId,
      side: this.side,
      price: this.price,
      orderQuantity: this.orderQuantity,
      openQuantity: this.openQuantity,
      state: this.state,
      userData: this.userData,
      isProtectedMarket: this.isProtectedMarket, // market order protection flag
      ioc: this.ioc, // #398: IOC time-in-force (optional in schema; default false on restore)
      cumulativeFilledQuantity: this.cumulativeFilledQuantity,
      cumulativeQuoteValue: this.cumulativeQuoteValue,
      reservedAmount: this.reservedAmount,
      releasedAmount: this.releasedAmount,
    };
  }

  /**
   * Creates a structural clone of this order with linked-list pointers
   * reset to null.
   *
   * Used by `OrderBook.clone()` to build a sandbox book for the Step 2
   * compute-then-commit pipeline (see
   * `docs/architecture/06-step2-engine-atomicity-refactor.md` §5.6). The
   * caller is responsible for re-linking `_prev` / `_next` / `_limit`
   * by inserting the clone into a clone-side `Limit` (e.g., via
   * `Limit.clone()` which calls `Limit.addOrder()` and rebuilds the
   * intrusive linked list correctly).
   *
   * Field-completeness contract: every mutable runtime field on `Order`
   * must be copied. Missing one means the clone diverges from the live
   * order on the very first matching operation. The list below is
   * exhaustive against `order.ts:91-137` — keep them in sync if new
   * fields are added.
   *
   * Linked-list pointers are deliberately reset:
   * - `_prev` / `_next` — caller's `Limit.clone()` rebuilds the list.
   * - `_limit` — set by `Limit.addOrder()` when the clone is inserted.
   *
   * The constructor enforces price/quantity invariants. Since this clone
   * mirrors a pre-existing valid order, those invariants hold by
   * construction (filled orders keep `orderQuantity > 0`; only
   * `openQuantity` can be 0).
   *
   * **userData is shared by REFERENCE** (PR1.1 reviewer M3). Both the
   * live and clone Orders point at the same `TUserData` object.
   * Production code never mutates `userData` post-construction (it
   * carries the user's identity + static metadata), so this is safe
   * today. Callers MUST NOT mutate `userData` after the order has been
   * cloned, or the mutation will alias both sides of the sandbox
   * boundary and silently violate compute purity.
   */
  public clone(): Order<TUserData> {
    const c = new Order<TUserData>(
      this.orderId,
      this.side,
      this.price,
      this.orderQuantity,
      this.userData ?? undefined,
    );
    // Mutable lifecycle fields — must mirror the live order exactly.
    c.openQuantity = this.openQuantity;
    c.serverOrderId = this.serverOrderId;
    c.state = this.state;
    c.isProtectedMarket = this.isProtectedMarket;
    c.ioc = this.ioc; // #398: sandbox must match the live order's IOC residual-cancel behavior
    c.cumulativeFilledQuantity = this.cumulativeFilledQuantity;
    c.cumulativeQuoteValue = this.cumulativeQuoteValue;
    c.reservedAmount = this.reservedAmount;
    c.releasedAmount = this.releasedAmount;
    // _prev / _next / _limit stay null by construction.
    return c;
  }

  /**
   * Creates a plain JavaScript object that is safe to be serialized to JSON.
   * Converts all BigInts to strings and explicitly excludes internal pointers.
   *
   * CRITICAL: Linked-list pointers (_prev, _next, _limit) are runtime-only
   * and must NEVER be persisted to WAL or snapshots. They are rebuilt when
   * orders are re-added to Limits during recovery.
   */
  public toSerializableObject(): SerializedOrder {
    // Start from the clean snapshot (excludes internal linked-list pointers)
    // then normalize EVERY BigInt field to a string. Previously this method
    // only stringified four fields explicitly (price, orderQuantity,
    // openQuantity, serverOrderId) while others (cumulativeFilledQuantity,
    // cumulativeQuoteValue) passed through as native BigInt and made
    // JSON.stringify throw — see shutdown-snapshot spam that triggered the
    // ghost-orders bug on restart. One formula for all Quantity/Price/Id
    // fields; null values pass through unchanged (typeof null === "object"
    // so the BigInt branch is skipped), matching the old ternary's semantics
    // for serverOrderId without the special-case.
    const snap = this.snapshot();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(snap)) {
      result[key] = typeof value === "bigint" ? value.toString() : value;
    }
    // Deliberate narrow cast: the loop above maps every OrderSnapshot field
    // bigint→string and passes the rest through unchanged — which is the
    // SerializedOrder shape by construction. TS cannot prove a key-wise
    // Object.entries transform, so we assert it here (and only here).
    return result as unknown as SerializedOrder;
  }
}

/**
 * Validates and reconstructs an Order from serialized data.
 * CRITICAL (v3.5): Enforces schema versioning to prevent silent flag loss on crash recovery.
 *
 * P0 DURABILITY REQUIREMENT:
 * This function MUST be used when reconstructing orders from WAL replay or snapshot restore.
 * Without this validation, a protected IOC order could become a resting limit order on
 * recovery, breaking the risk invariant that guarantees zero overdrafts.
 *
 * @param snapshot Serialized order data (from WAL or snapshot)
 * @returns Reconstructed Order instance with all properties validated and restored
 * @throws Error if schemaVersion is missing or incompatible
 * @throws Error if isProtectedMarket is undefined (schema corruption)
 *
 * @example
 * ```typescript
 * // WAL replay
 * const serialized = walLog.read();
 * const order = deserializeOrder(serialized); // Validates before reconstructing
 * orderBook.add(order);
 * ```
 */
export function deserializeOrder<TUserData = unknown>(
  snapshot: SerializedOrder,
): Order<TUserData> {
  // Runtime guards are RETAINED despite the compile-time type — `snapshot`
  // comes from disk (WAL / snapshot files), so corrupted or legacy data can
  // violate the declared shape regardless of what the type says.

  // Schema version validation
  if (snapshot.schemaVersion === undefined) {
    throw new Error(
      `Order snapshot missing schemaVersion. This indicates WAL corruption or ` +
        `incompatible data format. Cannot safely restore order: ${snapshot.orderId}`,
    );
  }

  // Strict Version Invariance
  // We do not allow "lower or equal". We only allow the exact version
  // the risk engine was audited for.
  if (snapshot.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new FatalEngineError(
      `DURABILITY CRITICAL: WAL version ${snapshot.schemaVersion} is incompatible with Engine version ${CURRENT_SCHEMA_VERSION}. Aborting to prevent risk bypass.` +
        `Order ID: ${snapshot.orderId}`,
    );
  }

  // Protected flag validation
  if (snapshot.isProtectedMarket === undefined) {
    throw new Error(
      `Order snapshot missing isProtectedMarket flag. This would cause a protected ` +
        `order to become a resting limit order on recovery, breaking risk invariants. ` +
        `Order: ${snapshot.orderId}, Price: ${snapshot.price}`,
    );
  }

  // Reconstruct order with all fields. userData is `unknown` on the wire
  // (passed through by reference at serialization time) — the caller's
  // TUserData claim is asserted here, exactly as the old untyped code did
  // implicitly.
  const order = new Order<TUserData>(
    snapshot.orderId,
    snapshot.side,
    toBoundedBigInt(snapshot.price, "price"),
    toBoundedBigInt(snapshot.orderQuantity, "orderQuantity"),
    (snapshot.userData ?? undefined) as TUserData | undefined,
  );

  // Restore protected flag (CRITICAL for IOC behavior)
  order.isProtectedMarket = snapshot.isProtectedMarket;

  // #398: restore IOC flag. Optional/additive — pre-#398 snapshots lack it and
  // default to false (GTC). This is sound: IOC orders never rest, so any order
  // present in a book snapshot is GTC by construction. Deliberately NOT guarded
  // like isProtectedMarket (which throws on undefined) — that guard exists to
  // prevent a protected order silently downgrading to a resting limit; an
  // absent ioc field has no such downgrade risk (false is the correct restore).
  order.ioc = snapshot.ioc ?? false;

  // Restore state
  order.openQuantity = toBoundedBigInt(snapshot.openQuantity, "openQuantity");
  order.state = snapshot.state;
  if (snapshot.serverOrderId) {
    order.serverOrderId = toBoundedBigInt(snapshot.serverOrderId, "serverOrderId");
  }
  // Restore cumulative fill tracking. Previously these were serialized in
  // toSerializableObject() but never restored here — every WAL replay / snapshot
  // reload reset them to 0 even for partially-filled resting orders, which is
  // why `cumulativeFilledQuantity` appeared as 1 (instead of 2) on the engine's
  // partialR order after Phase 7's restart.
  if (snapshot.cumulativeFilledQuantity !== undefined) {
    order.cumulativeFilledQuantity = toBoundedBigInt(
      snapshot.cumulativeFilledQuantity,
      "cumulativeFilledQuantity",
    );
  }
  if (snapshot.cumulativeQuoteValue !== undefined) {
    order.cumulativeQuoteValue = toBoundedBigInt(snapshot.cumulativeQuoteValue, "cumulativeQuoteValue");
  }
  if (snapshot.reservedAmount !== undefined) {
    order.reservedAmount = toBoundedBigInt(snapshot.reservedAmount, "reservedAmount");
  }
  if (snapshot.releasedAmount !== undefined) {
    order.releasedAmount = toBoundedBigInt(snapshot.releasedAmount, "releasedAmount");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ensure linked-list pointers are cleared (defensive)
  // When replaying a WAL, we create "fresh" objects with no neighbors.
  // The OrderBook will re-link them as it calls addOrder during replay.
  // ═══════════════════════════════════════════════════════════════════════════
  order._prev = null;
  order._next = null;
  order._limit = null;

  return order;
}
