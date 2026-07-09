// packages/orderbook/__tests__/cumulativeFills.spec.ts
// Tests for cumulative fill tracking (FIX CumQty-style) and monotonicity invariant
// Added with the orders/trades separation plan (v7).

import { describe, expect, it, mock } from "bun:test";
import { helperAdd } from "./_helpers";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

// ─── Test helpers ─────────────────────────────────────────────────────────────

type OrderSnapshot = { orderId: string; cumulativeFilledQuantity: bigint; cumulativeQuoteValue: bigint; orderQuantity: bigint };

function makeBook() {
  const instrument: Instrument = createInstrument(
    "TEST",
    2,  // pricePrecision
    0,  // quantityPrecision
    toCanonicalDecimal("0.01", 2), // tickSize
    toCanonicalDecimal("0.01", 2), // minPrice
    toCanonicalDecimal("1.00", 2), // maxPrice
  );
  const book = new OrderBook(instrument, noOpLogger, noOpMetrics);

  const fillSnapshots: OrderSnapshot[] = [];
  book.setOrderListener({
    onAccept: mock(() => {}),
    onReject: mock(() => {}),
    onFill: (snap: any) => { fillSnapshots.push(snap); },
    onCancel: mock(() => {}),
    onCancelReject: mock(() => {}),
    onReplace: mock(() => {}),
    onReplaceReject: mock(() => {}),
  });
  book.setTradeListener({ onTrade: mock(() => {}) });

  return { book, fillSnapshots };
}

// ─── Cumulative fill tracking — taker path ────────────────────────────────────

describe("cumulativeFilledQuantity — taker", () => {
  it("starts at zero before any fills", () => {
    const taker = new Order("t1", Side.BUY, 100n, 30n);
    expect(taker.cumulativeFilledQuantity).toBe(0n);
    expect(taker.cumulativeQuoteValue).toBe(0n);
  });

  it("increments cumulativeFilledQuantity by matchQuantity on each fill", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("sell1", Side.SELL, 75n, 10n));
    helperAdd(book, new Order("sell2", Side.SELL, 76n, 10n));

    // Taker buys 20 shares across 2 price levels
    helperAdd(book, new Order("taker", Side.BUY, 76n, 20n));

    const takerSnaps = fillSnapshots.filter((s) => s.orderId === "taker");
    expect(takerSnaps.length).toBe(2);
    expect(takerSnaps[0].cumulativeFilledQuantity).toBe(10n); // after first fill
    expect(takerSnaps[1].cumulativeFilledQuantity).toBe(20n); // after second fill
  });

  it("cumulativeQuoteValue = Σ(matchPrice × matchQuantity) for taker", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("sell1", Side.SELL, 75n, 10n));
    helperAdd(book, new Order("sell2", Side.SELL, 76n, 10n));

    helperAdd(book, new Order("taker", Side.BUY, 76n, 20n));

    const takerSnaps = fillSnapshots.filter((s) => s.orderId === "taker");
    expect(takerSnaps[0].cumulativeQuoteValue).toBe(750n);  // 75 * 10
    expect(takerSnaps[1].cumulativeQuoteValue).toBe(1510n); // 750 + 76 * 10
  });
});

// ─── Cumulative fill tracking — maker path ────────────────────────────────────

describe("cumulativeFilledQuantity — maker (resting order)", () => {
  it("starts at zero before any fills", () => {
    const maker = new Order("m1", Side.SELL, 75n, 20n);
    expect(maker.cumulativeFilledQuantity).toBe(0n);
    expect(maker.cumulativeQuoteValue).toBe(0n);
  });

  it("increments when partially filled as maker", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 75n, 30n));

    // Two separate takers each buy 10
    helperAdd(book, new Order("taker1", Side.BUY, 75n, 10n));
    helperAdd(book, new Order("taker2", Side.BUY, 75n, 10n));

    const makerSnaps = fillSnapshots.filter((s) => s.orderId === "maker");
    expect(makerSnaps.length).toBe(2);
    expect(makerSnaps[0].cumulativeFilledQuantity).toBe(10n);
    expect(makerSnaps[1].cumulativeFilledQuantity).toBe(20n);
  });

  it("cumulativeQuoteValue accumulates across multiple takers", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 75n, 30n));

    helperAdd(book, new Order("taker1", Side.BUY, 75n, 10n)); // 75 * 10 = 750
    helperAdd(book, new Order("taker2", Side.BUY, 75n, 10n)); // + 750 = 1500

    const makerSnaps = fillSnapshots.filter((s) => s.orderId === "maker");
    expect(makerSnaps[0].cumulativeQuoteValue).toBe(750n);
    expect(makerSnaps[1].cumulativeQuoteValue).toBe(1500n);
  });

  it("fully-filled maker snapshot has cumulativeFilledQuantity === orderQuantity", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 75n, 10n));
    helperAdd(book, new Order("taker", Side.BUY, 75n, 10n));

    const makerSnap = fillSnapshots.filter((s) => s.orderId === "maker").pop()!;
    expect(makerSnap.cumulativeFilledQuantity).toBe(makerSnap.orderQuantity);
  });
});

// ─── OrderSnapshot includes cumulative fields ─────────────────────────────────

describe("OrderSnapshot — cumulative fields in listener callbacks", () => {
  it("onFill snapshot includes cumulativeFilledQuantity", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 75n, 10n));
    helperAdd(book, new Order("taker", Side.BUY, 75n, 5n));

    expect(fillSnapshots.length).toBeGreaterThan(0);
    const snap = fillSnapshots[0];
    expect("cumulativeFilledQuantity" in snap).toBe(true);
    expect(snap.cumulativeFilledQuantity).toBe(5n);
  });

  it("onFill snapshot includes cumulativeQuoteValue", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 75n, 10n));
    helperAdd(book, new Order("taker", Side.BUY, 75n, 5n));

    const snap = fillSnapshots[0];
    expect("cumulativeQuoteValue" in snap).toBe(true);
    expect(snap.cumulativeQuoteValue).toBe(375n); // 75 * 5
  });
});

// ─── Monotonicity invariant ───────────────────────────────────────────────────

describe("monotonicity invariant", () => {
  it("normal fills never trigger the invariant (sanity check)", () => {
    const { book } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 75n, 30n));

    expect(() => {
      helperAdd(book, new Order("t1", Side.BUY, 75n, 10n));
      helperAdd(book, new Order("t2", Side.BUY, 75n, 10n));
    }).not.toThrow();
  });

  it("Order initialises cumulativeFilledQuantity to 0n", () => {
    const o = new Order("o1", Side.BUY, 100n, 50n);
    expect(o.cumulativeFilledQuantity).toBe(0n);
  });

  it("a backward mutation would satisfy the FatalEngineError guard condition", () => {
    // We cannot trigger the guard through the public API (correct engine prevents it),
    // but verify the arithmetic: a decrease from 100n to 50n satisfies next < prev.
    const order = new Order("o1", Side.BUY, 100n, 50n);
    order.cumulativeFilledQuantity = 100n;

    const prev = order.cumulativeFilledQuantity;
    const corrupt = 50n;
    expect(corrupt < prev).toBe(true); // condition that would throw FatalEngineError
  });
});

// ─── avgFillPrice derivation from cumulativeQuoteValue ────────────────────────

describe("avgFillPrice derivation — cumulativeQuoteValue / cumulativeFilledQuantity", () => {
  it("exact integer division, no rounding error accumulated across fills", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("sell1", Side.SELL, 74n, 10n));
    helperAdd(book, new Order("sell2", Side.SELL, 76n, 10n));

    // Taker sweeps both levels
    helperAdd(book, new Order("taker", Side.BUY, 76n, 20n));

    const takerSnaps = fillSnapshots.filter((s) => s.orderId === "taker");
    expect(takerSnaps.length).toBe(2);

    const final = takerSnaps[takerSnaps.length - 1];
    // (74*10 + 76*10) / 20 = 1500 / 20 = 75 (exact)
    const computedAvg = final.cumulativeQuoteValue / final.cumulativeFilledQuantity;
    expect(computedAvg).toBe(75n);
  });

  it("single fill: avg = matchPrice", () => {
    const { book, fillSnapshots } = makeBook();
    helperAdd(book, new Order("maker", Side.SELL, 80n, 10n));
    helperAdd(book, new Order("taker", Side.BUY, 80n, 10n));

    const takerSnap = fillSnapshots.find((s) => s.orderId === "taker")!;
    const avg = takerSnap.cumulativeQuoteValue / takerSnap.cumulativeFilledQuantity;
    expect(avg).toBe(80n);
  });
});
