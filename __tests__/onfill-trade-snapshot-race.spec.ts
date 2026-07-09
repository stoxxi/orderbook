// packages/orderbook/__tests__/onfill-trade-snapshot-race.spec.ts
//
// Regression test for the taker-snapshot trade-pool race surfaced
// 2026-05-21 in production.
//
// The bug: in `orderBook.createTrade`, the TAKER's `onFill` listener
// received a trade snapshot via `trade.snapshot()` called INSIDE the
// deferred callback (orderBook.ts:1428). But `tradePool.release(trade)`
// runs at orderBook.ts:1388 — AFTER `fillOrder` schedules the deferred
// callback but BEFORE the callback actually executes. So by the time
// the closure runs and calls `trade.snapshot()`, the trade has been
// returned to the pool and its `matchPrice` / `matchQuantity` fields
// have been zeroed. Result: the taker's onFill listener saw a snapshot
// with matchPrice=0n / matchQuantity=0n.
//
// Downstream impact: the engine's WS broadcast helper
// (`computePostSettleBalance` in `apps/engine/src/wsBalance.ts`)
// computes `cost = matchPrice × matchQuantity`, which became 0, so
// the FE-visible balance never updated after a fill even though the
// engine ledger was correct. SETTLE_TRADE was unaffected because it
// uses the maker's eagerly-captured snapshot.
//
// The maker side at orderBook.ts:1363 already does it right: captures
// `tradeSnapshot` once via `const tradeSnapshot = trade.snapshot()` at
// line 1311, and the deferred maker callback closes over that const.
//
// The fix mirrors that pattern in `fillOrder`: capture
// `const tradeSnapshot = trade.snapshot()` BEFORE the deferred
// callback, and have the callback close over that const instead of
// calling `trade.snapshot()` lazily.

import { describe, expect, it, mock } from "bun:test";
import { helperAdd } from "./_helpers";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

function makeBook() {
  const instrument: Instrument = createInstrument(
    "TEST",
    2,
    0,
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("1.00", 2),
  );
  const book = new OrderBook(instrument, noOpLogger, noOpMetrics);

  // Capture per-fill snapshots so we can assert both maker- AND taker-side
  // received correct matchPrice / matchQuantity.
  const fills: Array<{ orderId: string; tradeMatchPrice: bigint; tradeMatchQuantity: bigint }> = [];
  book.setOrderListener({
    onAccept: mock(() => {}),
    onReject: mock(() => {}),
    onFill: (orderSnap: any, tradeSnap: any) => {
      fills.push({
        orderId: orderSnap.orderId,
        tradeMatchPrice: tradeSnap.matchPrice,
        tradeMatchQuantity: tradeSnap.matchQuantity,
      });
    },
    onCancel: mock(() => {}),
    onCancelReject: mock(() => {}),
    onReplace: mock(() => {}),
    onReplaceReject: mock(() => {}),
  });
  book.setTradeListener({ onTrade: mock(() => {}) });

  return { book, fills };
}

describe("onFill trade snapshot — taker-side pool-reuse race (regression)", () => {
  it("taker's onFill receives the correct trade snapshot (not zeros)", () => {
    const { book, fills } = makeBook();

    // Maker rests a SELL @ 26 for 1 share.
    const maker = new Order("maker-1", Side.SELL, 26n, 1n);
    helperAdd(book,maker);

    // Taker submits BUY @ 26 for 1 share → matches against maker.
    const taker = new Order("taker-1", Side.BUY, 26n, 1n);
    helperAdd(book,taker);

    // Both onFill events fired — maker + taker.
    expect(fills).toHaveLength(2);

    const makerFill = fills.find((f) => f.orderId === "maker-1");
    const takerFill = fills.find((f) => f.orderId === "taker-1");
    expect(makerFill).toBeDefined();
    expect(takerFill).toBeDefined();

    // PRE-FIX: makerFill had correct values (snapshot captured eagerly),
    // takerFill had matchPrice=0n / matchQuantity=0n (snapshot captured
    // after tradePool.release zeroed the trade).
    // POST-FIX: both have correct values.
    expect(makerFill!.tradeMatchPrice).toBe(26n);
    expect(makerFill!.tradeMatchQuantity).toBe(1n);
    expect(takerFill!.tradeMatchPrice).toBe(26n);
    expect(takerFill!.tradeMatchQuantity).toBe(1n);
  });

  it("multi-fill: every taker onFill snapshot is correct, not just the first", () => {
    const { book, fills } = makeBook();

    // Three makers rest at SELL @ 26 for 1 share each.
    helperAdd(book,new Order("maker-1", Side.SELL, 26n, 1n));
    helperAdd(book,new Order("maker-2", Side.SELL, 26n, 1n));
    helperAdd(book,new Order("maker-3", Side.SELL, 26n, 1n));

    // Taker sweeps with BUY @ 26 for 3 shares.
    helperAdd(book,new Order("taker-1", Side.BUY, 26n, 3n));

    // 3 makers + 3 taker-side fills = 6 onFill events.
    expect(fills).toHaveLength(6);

    const takerFills = fills.filter((f) => f.orderId === "taker-1");
    expect(takerFills).toHaveLength(3);

    // Each taker fill snapshot must carry the correct matchPrice/Quantity.
    // PRE-FIX: all three would be (0n, 0n) because each one's snapshot was
    // taken lazily after the pool released the corresponding trade.
    for (const fill of takerFills) {
      expect(fill.tradeMatchPrice).toBe(26n);
      expect(fill.tradeMatchQuantity).toBe(1n);
    }
  });
});
