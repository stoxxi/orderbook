# @stoxxi/orderbook

**A deterministic, in-memory, price-time-priority limit order book (CLOB) matching engine for TypeScript — pure logic, `bigint` arithmetic, zero I/O.**

Given the same command stream, it produces the same trades, the same book state, and the same event sequence — every time, on every machine. That makes it safe to journal commands to a write-ahead log and rebuild the exact book state by replay. This is the matching core that powers [stoxxi.com](https://stoxxi.com), a production virtual-money prediction exchange — extracted as a standalone library; the surrounding system (balances, persistence, networking) stays yours.

- **Deterministic replay** — no wall-clock reads, no randomness, no reliance on object iteration order; time is an injected logical timestamp.
- **Strict price-time priority** — best price first, FIFO within a price level; no reordering, no hidden priority rules.
- **Exact arithmetic** — every price/quantity is a scaled `bigint`; no floats anywhere, no rounding drift.
- **O(1) cancel** — orders are intrusive linked-list nodes, unlinked without scanning; price levels live in a balanced tree (O(log n)).
- **FIX-aligned lifecycle** — order states and reject reasons modeled on FIX 5.0 SP2 `OrdStatus` (tag 39) / `OrdRejReason` (tag 103).
- **One runtime dependency** — [`@js-sdsl/ordered-map`](https://github.com/js-sdsl/js-sdsl).

Links: [npm](https://www.npmjs.com/package/@stoxxi/orderbook) · [source](https://github.com/stoxxi/orderbook) · [issues](https://github.com/stoxxi/orderbook/issues)

## Non-goals

This package matches orders. It deliberately does **not** manage balances or margin, persist anything (it *produces* snapshots; you store them), do networking, timers, or async I/O, provide idempotency/halting/distributed coordination, or tolerate concurrent mutation (single-threaded by contract). Those belong to the host system around it.

## Install

```bash
npm install @stoxxi/orderbook    # or: bun add / pnpm add / yarn add
```

Works on Node.js ≥ 18 and Bun. TypeScript types ship in the package. **ESM-only** — there is no CommonJS build (`require()` is not supported; use `import`).

## Quickstart

```ts
import { IdGenerator, Order, OrderBook, Side } from "@stoxxi/orderbook";

// A book for a symbol priced to 2 decimals, whole-unit quantities.
const book = OrderBook.create("DEMO", {
  pricePrecision: 2,
  quantityPrecision: 0,
  tickSize: "0.01",
});

// The host assigns server order ids (sids) — monotonic, before the book sees
// the order. This is what makes cancel/replace replayable (see Determinism).
const idGen = new IdGenerator();

// Log every trade.
book.setTradeListener({
  onTrade: (b, trade) =>
    console.log(
      `TRADE ${b.fromInternalQuantity(trade.matchQuantity)} @ ${b.fromInternalPrice(trade.matchPrice)}`,
    ),
});

// Logical time: any monotonic ms value owned by YOUR sequencer.
let ts = 1_000_000;

// A resting SELL at 10.05.
const ask = new Order("alice-1", Side.SELL, book.toInternalPrice("10.05"), 5n);
ask.serverOrderId = idGen.next();
book.add(ask, ts++);

// A BUY that crosses it — takes 3 of the 5; the ask keeps 2 resting.
const bid = new Order("bob-1", Side.BUY, book.toInternalPrice("10.05"), 3n);
bid.serverOrderId = idGen.next();
const result = book.add(bid, ts++);

console.log(result.status);            // "FILLED"
console.log(result.fills);             // [{ price: 1005n, quantity: 3n }]

// Top of book after the partial fill:
const bbo = book.getBbo();
console.log(book.fromInternalPrice(bbo.askPrice)); // "10.05" (2 left)

// Cancel the remainder — O(1).
book.cancel(ask.serverOrderId!, ts++);
```

Runnable versions: [`examples/basic.ts`](https://github.com/stoxxi/orderbook/blob/main/examples/basic.ts) and [`examples/snapshot-restore.ts`](https://github.com/stoxxi/orderbook/blob/main/examples/snapshot-restore.ts) (`bun run examples/basic.ts`).

### Snapshot & restore

```ts
// Serialize the full resting state (all bigints are already strings — plain JSON).
const snap = book.exportSnapshot(book.getSymbol());
const json = JSON.stringify(snap);

// Later / elsewhere: restore into a book with the same instrument config…
const restored = OrderBook.create("DEMO", {
  pricePrecision: 2,
  quantityPrecision: 0,
  tickSize: "0.01",
});
restored.importSnapshot(JSON.parse(json));
await restored.recover(); // post-restore invariant verification (throws if corrupt)

// …and continue: the same subsequent commands now produce the same trades
// on `restored` as they would have on `book`.
```

`importSnapshot` hard-fails on a schema-version mismatch rather than guessing — a mis-restored book is worse than a loud abort.

**Snapshot/wire trust.** `importSnapshot`, `deserializeOrder`, and `wireToTradeSnapshot` treat their input as **untrusted** (it may transit disk or network). Every serialized numeric field is length-capped before `BigInt` conversion (a defence against a huge digit string stalling the single-threaded matching loop) and range-checked against instrument bounds; a malformed or hostile record fails loudly (`FatalEngineError`, or `TypeError` for wire records) **before** any live state is mutated — the restore is two-phase and all-or-nothing. Callers need not pre-sanitise, but should still transport snapshots over an integrity-checked channel: this package validates *shape and range*, not *authenticity*.

## The numeric model (read this once)

Every price and quantity is a **scaled `bigint`**: `"10.05"` at `pricePrecision: 2` is `1005n`. The book never parses or formats decimals on the hot path — you convert at the edges:

| You have | You want | Use |
|---|---|---|
| `"10.05"` (display) | `1005n` (internal) | `book.toInternalPrice("10.05")` |
| `1005n` (internal) | `"10.05"` (display) | `book.fromInternalPrice(1005n)` |
| display quantity | internal | `book.toInternalQuantity("1.5")` |
| internal quantity | display | `book.fromInternalQuantity(15n)` |

Instrument configuration (tick size, min/max price) is ingested **only from canonical decimal strings** (`createInstrument` / `toCanonicalDecimal`) — never floats — so `0.00000002` means exactly that, not `1.9999998e-8`. Precision is capped at 18 decimals and values at `10^18 − 1` (fits a Postgres `bigint`).

Standalone math helpers (`computeNotional`, `snapToTick`, `rescaleCost`, …) are also available via the `@stoxxi/orderbook/math` entry point.

## The determinism / replay contract

The book is a **pure state machine**. It holds if you follow three rules:

1. **Single-threaded, sequential commands.** One `add`/`cancel`/`replace` at a time; no interleaving. (Reentrancy from inside a listener is detected and rejected.)
2. **The host owns identity.** Assign `order.serverOrderId` from your own monotonic `IdGenerator` *before* calling `add`, and journal the command — sid included — before applying it. Replay then references the same sids. The book fatals on a missing or colliding sid rather than repairing it.
3. **The host owns time.** Pass your sequencer's timestamp as the `logicalTimestamp` argument. The book never calls `Date.now()`; if you omit the argument it reuses the last logical time (deterministic, if stale) rather than reading the clock.

Under those rules: same starting state (empty or a snapshot) + same command sequence ⇒ identical trades, identical book, identical event order. That is the entire recovery story — journal commands to your WAL, snapshot periodically with `exportSnapshot`, and recover with `importSnapshot` + replay of the post-snapshot suffix + `recover()`.

## Public API

Everything below is exported from the package root with full TSDoc (generate API docs with [TypeDoc](https://typedoc.org/) if you want a browsable site).

**Book lifecycle** — `OrderBook.create(symbol, options?)` · `new OrderBook(instrument, logger?, metrics?, stpPolicy?)` · `createInstrument(...)` · `book.clone(metricsOverride?)` (deep sandbox copy sharing no mutable state).

**Trading** — `book.add(order, ts?) → MatchingResult` · `book.cancel(sid, ts?)` · `book.replace(sid, newQty, newPrice, ts?)`. Rejections throw a typed `OrderBookError` (with a FIX-aligned `code`) *and* fire the corresponding listener reject callback; fatal invariant violations throw `FatalEngineError` — halt, don't catch.

`MatchingResult.status` reflects the order's **final state**, orthogonal to whether it had fills: `"FILLED"` (fully executed), `"RESTING"` (remainder on the book), `"CANCELED"` (IOC residual canceled — market, protected-market, or limit-IOC).

**Replace semantics (FIX):** price change or quantity *increase* loses time priority (atomic unlink + re-add, may match immediately); quantity *decrease* retains it.

**Market data** — `getBbo()` · `getDepth()` · `getDepthDeltas()` (changed levels since last flush) · `getStats24h()` · `getBestBidPrice()` / `getBestAskPrice()` · `lastTradePrice`.

**Orders & queries** — `status(sid)` · `getOrder(sid)` · `getOrdersForUser(userId)` · `iterateRestingOrders()`.

**Snapshot & recovery** — `exportSnapshot(symbol)` · `importSnapshot(data)` · `recover()` · `deserializeOrder(serialized)` (schema-gated) · `CURRENT_SCHEMA_VERSION`.

**Self-trade prevention** — inject an `STPPolicy` at construction: `NoSTPPolicy` (default, allows all) or `UserSTPPolicy` (blocks same-`userId` matches), or implement your own single-method policy; it runs inline in the matching loop, so keep it to field comparisons.

**Host integration seams** — `ILogger`/`noOpLogger` and `IExchangeMetrics`/`noOpMetrics` are tiny vendored interfaces (silent no-ops by default); implement them to route the book's structured diagnostics and trade counters into your own stack.

### Events

One listener per channel, registered with `setOrderListener` / `setTradeListener` / `setBboListener` / `setDepthListener`. Callbacks run **synchronously, after** the triggering operation has fully committed its state mutation (order/trade/depth events via a deferred queue; BBO inline at notification time), so they always observe a consistent book; a throwing listener is caught and logged, never corrupting matching. Keep listeners non-blocking and free of async I/O.

- `OrderListener` — `onAccept`, `onReject`, `onFill`, `onCancel`, `onCancelReject`, `onReplace`, `onReplaceReject`
- `TradeListener` — `onTrade` (+ optional `onCandleClosed` for 1-minute OHLCV candles)
- `BboListener` — `onBboChange`. **Important:** the `Bbo` object is a reused double-buffer: read it synchronously or copy its primitives; never retain the reference.
- `DepthListener` — `onDepthChange` (full ladder; can be frequent — consider `getDepthDeltas()` polling instead for hot markets)

### FIX lifecycle mapping

States and reject codes are *modeled on* FIX 5.0 SP2 (not a claim of protocol coverage):

| `OrderState` | FIX OrdStatus (39) | | `OrderRejectReason` | FIX OrdRejReason (103) |
|---|---|---|---|---|
| `NEW` | 0 | | `UnknownOrder` | 5 |
| `PARTIALLY_FILLED` | 1 | | `DuplicateOrder` | 6 |
| `FILLED` | 2 | | `IncorrectQuantity` | 13 |
| `CANCELED` | 4 | | `InvalidInvestorID` | 18 (deviation — see `reasons.ts`) |
| `PENDING_CANCEL` | 6 | | `Other` | 99 |
| `REJECTED` | 8 | | `UnknownSymbol`, `MarketClosed`, `UserContextRequired` | 100–103 (custom) |
| `PENDING_NEW` | A | | `InvalidPrice` … `InsufficientAvailableShares` | 9901–9908 (custom) |
| `PENDING_REPLACE` | E | | | |

## Performance

Honest envelope, measured on Bun (dev laptop — MacBook Pro, Apple M1 Pro, 16 GB, 2026) — see [BENCHMARKS.md](https://github.com/stoxxi/orderbook/blob/main/BENCHMARKS.md) for methodology and full percentiles:

- **~758k matches/sec** (~1.3 µs/match) and **~686k adds/sec** sustained over 1M-op runs.
- **Cancel p50 ~0.13–0.17 µs** (p999 ≤ 13.4 µs), position-independent — the O(1) claim is benchmarked, not asserted.
- Matching is **not** allocation-free (snapshots and deferred callbacks allocate); the `Trade` pool and BBO double-buffer keep the steady-state hot path allocation-light. This is a TypeScript engine: judge it against ~µs-class targets, not C++ sub-microsecond matchers.

Complexity: add O(log n) in price levels; cancel O(1); replace O(1) retained / O(log n) priority-lost; BBO O(1); aggressive match O(k log n) for k makers swept.

## Invariants

The invariants the engine enforces (no floats, single ownership, `totalQuantity` = Σ open quantity, pointer integrity, no empty price levels, post-replay verification) are catalogued in [INVARIANTS.md](https://github.com/stoxxi/orderbook/blob/main/INVARIANTS.md). Internal tripwires throw `FatalEngineError` instead of limping — on that error, halt and recover from your journal.

## Testing

756 tests (unit, property-based, determinism/replay-equivalence, adversarial lifecycle, deserialize hardening) run with `bun test`. Benchmarks live in `__bench__/` (`bun run bench`).

## Contributing

**Bug reports and questions are very welcome — please [open an issue](https://github.com/stoxxi/orderbook/issues).**

This repository is a published mirror: the engine is developed in a private upstream project and mirrored here on each release, so pull requests opened against this repo can't be merged directly (the next release would overwrite them). If you have a fix or improvement, open an issue describing it — accepted changes are ported upstream and land in the next version, with credit. See [CONTRIBUTING.md](https://github.com/stoxxi/orderbook/blob/main/CONTRIBUTING.md).

Design guarantees that any change must preserve: no behaviour change without a failing test first; determinism is sacred (nothing time-, random-, or iteration-order-dependent may enter matching); all arithmetic stays `bigint`.

## Support

This engine is MIT-licensed and free to use commercially. If it saves you time and you'd like to give back, donations are welcome (never expected):

- **BTC:** `bc1quchs2g84xh2x02353pvdxrmde054pjtqcc0cwm`
- **ETH:** `0x1DE768f78444325c6386213119C496f5fFc03fb4`

## License

MIT © [Double Digitize](https://stoxxi.com) — see [LICENSE](https://github.com/stoxxi/orderbook/blob/main/LICENSE).
