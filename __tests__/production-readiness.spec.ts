// packages/orderbook/__tests__/production-readiness.spec.ts
//
// Phase 4 tests from the Production Readiness Plan:
// 4.1 Forward-Consistency Replay Test
// 4.2 Bi-Directional Invariant Corruption Test
// 4.3 O(N²) Regression Benchmark

import { describe, expect, test } from "bun:test";
import { helperAdd, helperSyncAfterImport } from "./_helpers";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { createInstrument, toCanonicalDecimal } from "../src/instrument";
import { FatalEngineError } from "../src/errors";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side, type Price, type Quantity } from "../src/types";

// ─── Helpers ────────────────────────────────────────────────

function createBook(): OrderBook {
  const instrument = createInstrument(
    "TEST",
    2,
    0,
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("1000000.00", 2),
  );
  return new OrderBook(instrument, noOpLogger, noOpMetrics);
}

function makeLimitOrder(
  id: string,
  side: Side,
  price: bigint,
  qty: bigint,
): Order {
  return new Order(id, side, price as Price, qty as Quantity);
}

// ─── 4.1 Forward-Consistency Replay Test ────────────────────

describe("4.1 Forward Determinism & Replay Equivalence", () => {
  test("two books fed identical events produce identical snapshots", () => {
    const book1 = createBook();
    const book2 = createBook();

    // Deterministic event sequence with a fixed logical timestamp
    const events = [
      { id: "b1", side: Side.BUY, price: 10000n, qty: 100n, ts: 1000 },
      { id: "b2", side: Side.BUY, price: 9900n, qty: 200n, ts: 1001 },
      { id: "a1", side: Side.SELL, price: 10100n, qty: 150n, ts: 1002 },
      { id: "a2", side: Side.SELL, price: 10200n, qty: 50n, ts: 1003 },
      { id: "b3", side: Side.BUY, price: 10050n, qty: 75n, ts: 1004 },
      // Aggressive taker that crosses the spread
      { id: "t1", side: Side.BUY, price: 10100n, qty: 80n, ts: 1005 },
      // Partial cancel via replace (quantity decrease)
      { id: "b4", side: Side.BUY, price: 9900n, qty: 300n, ts: 1006 },
    ];

    // Feed identical events to both books
    for (const e of events) {
      const o1 = makeLimitOrder(e.id, e.side, e.price, e.qty);
      const o2 = makeLimitOrder(e.id, e.side, e.price, e.qty);
      helperAdd(book1, o1, e.ts);
      helperAdd(book2, o2, e.ts);
    }

    // Verify identical snapshots
    const snap1 = book1.exportSnapshot("TEST");
    const snap2 = book2.exportSnapshot("TEST");
    expect(snap1).toEqual(snap2);

    // Forward consistency: next event must yield identical MatchingResult
    const nextOrder1 = makeLimitOrder("fwd1", Side.SELL, 9900n, 50n);
    const nextOrder2 = makeLimitOrder("fwd1", Side.SELL, 9900n, 50n);
    const res1 = helperAdd(book1, nextOrder1, 2000);
    const res2 = helperAdd(book2, nextOrder2, 2000);

    expect(res1).toEqual(res2);

    // Final snapshots still match
    const finalSnap1 = book1.exportSnapshot("TEST");
    const finalSnap2 = book2.exportSnapshot("TEST");
    expect(finalSnap1).toEqual(finalSnap2);
  });

  test("cancel and replace produce identical state across replayed books", () => {
    const book1 = createBook();
    const book2 = createBook();

    const applyOps = (book: OrderBook) => {
      const b1 = makeLimitOrder("o1", Side.BUY, 10000n, 100n);
      const b2 = makeLimitOrder("o2", Side.BUY, 9900n, 200n);
      const a1 = makeLimitOrder("o3", Side.SELL, 10100n, 150n);

      helperAdd(book, b1, 1000);
      helperAdd(book, b2, 1001);
      helperAdd(book, a1, 1002);

      // Cancel o2
      book.cancel(2n, 1003);

      // Replace o1: quantity decrease (retains priority)
      book.replace(1n, 50n as Quantity, 10000n as Price, 1004);

      // Replace o3: price change (loses priority)
      book.replace(3n, 150n as Quantity, 10050n as Price, 1005);
    };

    applyOps(book1);
    applyOps(book2);

    const snap1 = book1.exportSnapshot("TEST");
    const snap2 = book2.exportSnapshot("TEST");
    expect(snap1).toEqual(snap2);
  });

  test("snapshot → import → forward event produces identical result", () => {
    const book1 = createBook();

    // Build up some state
    helperAdd(book1, makeLimitOrder("b1", Side.BUY, 10000n, 100n), 1000);
    helperAdd(book1, makeLimitOrder("b2", Side.BUY, 9900n, 200n), 1001);
    helperAdd(book1, makeLimitOrder("a1", Side.SELL, 10100n, 150n), 1002);

    // Snapshot and restore into book2
    const snap = book1.exportSnapshot("TEST");
    const book2 = createBook();
    book2.importSnapshot(snap);
    helperSyncAfterImport(book2);

    // Forward event on both
    const o1 = makeLimitOrder("fwd", Side.SELL, 10000n, 50n);
    const o2 = makeLimitOrder("fwd", Side.SELL, 10000n, 50n);
    const res1 = helperAdd(book1, o1, 2000);
    const res2 = helperAdd(book2, o2, 2000);

    expect(res1).toEqual(res2);
  });
});

// ─── 4.2 Bi-Directional Invariant Corruption Test ───────────

describe("4.2 Bi-Directional Invariant Detection", () => {
  test("detects ghost order: in orderMap but detached from Limit", () => {
    const book = createBook();

    // Add a resting order
    helperAdd(book, makeLimitOrder("ghost", Side.BUY, 10000n, 100n), 1000);

    // Surgically corrupt: detach the order's _limit pointer
    // This simulates the corruption the invariant check is designed to catch
    const order = book.getOrder(1n)!;
    expect(order).toBeDefined();

    // Forcibly corrupt the pointer (bypass type safety)
    (order as any)._limit = null;

    // The recovery invariant check should catch this
    expect(() => {
      (book as any).assertPostReplayInvariants();
    }).toThrow(FatalEngineError);
  });

  test("detects order claiming wrong Limit ownership", () => {
    const book = createBook();

    // Add orders at different prices
    helperAdd(book, makeLimitOrder("o1", Side.BUY, 10000n, 100n), 1000);
    helperAdd(book, makeLimitOrder("o2", Side.BUY, 9900n, 200n), 1001);

    // Get the first order and corrupt its _limit to point to a different object
    const order = book.getOrder(1n)!;
    const wrongLimit = { price: 9900n }; // Not the real Limit
    (order as any)._limit = wrongLimit;

    expect(() => {
      (book as any).assertPostReplayInvariants();
    }).toThrow(FatalEngineError);
  });

  test("passes invariant check on a healthy book", () => {
    const book = createBook();

    helperAdd(book, makeLimitOrder("b1", Side.BUY, 10000n, 100n), 1000);
    helperAdd(book, makeLimitOrder("b2", Side.BUY, 9900n, 200n), 1001);
    helperAdd(book, makeLimitOrder("a1", Side.SELL, 10100n, 150n), 1002);

    // Should not throw
    expect(() => {
      (book as any).assertPostReplayInvariants();
    }).not.toThrow();
  });
});

// ─── 4.3 O(N²) Regression Benchmark ────────────────────────

describe("4.3 O(N²) Callback Flush Regression", () => {
  test("sweeping 10k resting orders completes in O(N) time", () => {
    const book = createBook();
    const N = 10_000;

    // Place N resting sell orders at ascending prices
    for (let i = 0; i < N; i++) {
      const price = BigInt(10000 + i) as Price;
      helperAdd(book, 
        makeLimitOrder(`a${i}`, Side.SELL, price, 1n as Quantity),
        1000 + i,
      );
    }

    // Attach a listener so callbacks are actually queued
    let callbackCount = 0;
    book.setOrderListener({
      onAccept: () => { callbackCount++; },
      onReject: () => {},
      onFill: () => { callbackCount++; },
      onCancel: () => { callbackCount++; },
      onCancelReject: () => {},
      onReplace: () => {},
      onReplaceReject: () => {},
    });
    book.setTradeListener({ onTrade: () => { callbackCount++; } });

    // Sweep all N orders with a single aggressive buy
    const sweepPrice = BigInt(10000 + N) as Price;
    const start = performance.now();
    helperAdd(book, 
      makeLimitOrder("taker", Side.BUY, sweepPrice, BigInt(N) as Quantity),
      100000,
    );
    const elapsed = performance.now() - start;

    // Verify all orders were filled
    expect(callbackCount).toBeGreaterThan(N); // fills + trades + accept

    // The O(N²) bug caused >500ms for 10k orders.
    // With the O(N) fix, this should complete well under 100ms.
    // Use a generous threshold to avoid flaky CI, but catch quadratic blowup.
    expect(elapsed).toBeLessThan(500); // ms — generous, but catches O(N²)

    // Sanity: book should be empty on the sell side
    const bbo = book.getBbo();
    expect(bbo.askPrice).toBe(0n); // No asks left
  });
});
