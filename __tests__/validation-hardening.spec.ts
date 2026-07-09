// packages/orderbook/__tests__/validation-hardening.spec.ts
//
// Boundary/input validation hardening (Tier-1 audit):
//  1. importSnapshot is all-or-nothing and rejects corrupt/hostile snapshots
//     BEFORE mutating live state (was: clear-then-loop, threw mid-restore).
//  2. seedHistoricalVolume rejects out-of-range bucket indices (was: silently
//     grew the 24-slot ring, which importSnapshot then zeroed wholesale).
//  3. add()/replace() enforce the instrument's [minPrice, maxPrice] bounds
//     (documented as enforced; previously any tick-aligned magnitude rested).

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { createInstrument, toCanonicalDecimal } from "../src/instrument";
import { FatalEngineError } from "../src/errors";
import { Order } from "../src/order";
import { OrderBook, OrderBookSnapshotData } from "../src/orderBook";
import { Side, type Price, type Quantity } from "../src/types";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";

function boundedBook(): OrderBook {
  // minPrice 1.00, maxPrice 100.00 — a deliberately tight configured range.
  const inst = createInstrument(
    "BND", 2, 0,
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("1.00", 2),
    toCanonicalDecimal("100.00", 2),
  );
  return new OrderBook(inst, noOpLogger, noOpMetrics);
}

describe("importSnapshot atomicity + validation", () => {
  test("a corrupt order aborts the import WITHOUT mutating the prior book", () => {
    const book = OrderBook.create("SNAP");
    helperAdd(book, new Order("a", Side.BUY, 10000n, 5n), 1);
    helperAdd(book, new Order("b", Side.BUY, 9900n, 5n), 2);
    // Snapshot the healthy 2-order book, then corrupt one entry.
    const good = book.exportSnapshot("SNAP");

    const dst = OrderBook.create("SNAP2");
    helperAdd(dst, new Order("pre", Side.SELL, 11000n, 7n), 3); // dst has prior state
    const before = dst.exportSnapshot("SNAP2");

    const corrupt: OrderBookSnapshotData = structuredClone(good);
    corrupt.orders[0] = { ...corrupt.orders[0], price: "not-a-bigint" };
    expect(() => dst.importSnapshot(corrupt)).toThrow();

    // dst is untouched — not half-restored, not empty.
    expect(dst.exportSnapshot("SNAP2")).toEqual(before);
  });

  test("rejects negative quantity", () => {
    const book = OrderBook.create("SNAP3");
    helperAdd(book, new Order("a", Side.BUY, 10000n, 5n), 1);
    const snap = book.exportSnapshot("SNAP3");
    snap.orders[0] = { ...snap.orders[0], openQuantity: "-3" };
    expect(() => OrderBook.create("d").importSnapshot(snap)).toThrow(FatalEngineError);
  });

  test("rejects duplicate SID", () => {
    const book = OrderBook.create("SNAP4");
    helperAdd(book, new Order("a", Side.BUY, 10000n, 5n), 1);
    const snap = book.exportSnapshot("SNAP4");
    snap.orders.push({ ...snap.orders[0] }); // same SID twice
    expect(() => OrderBook.create("d").importSnapshot(snap)).toThrow(/duplicate SID/i);
  });

  test("a valid snapshot still round-trips", () => {
    const book = OrderBook.create("SNAP5");
    helperAdd(book, new Order("a", Side.BUY, 10000n, 5n), 1);
    helperAdd(book, new Order("b", Side.SELL, 10100n, 3n), 2);
    const snap = book.exportSnapshot("SNAP5");
    const dst = OrderBook.create("SNAP5b");
    expect(() => dst.importSnapshot(snap)).not.toThrow();
    // exportSnapshot's symbol arg is not restored state — compare with the same
    // symbol so we're asserting on the restored book, not the label.
    expect(dst.exportSnapshot("SNAP5")).toEqual(snap);
  });
});

describe("seedHistoricalVolume bounds", () => {
  test("rejects out-of-range index and preserves the 24-slot ring", () => {
    const book = OrderBook.create("SEED");
    book.seedHistoricalVolume(3, 100n, 1); // valid
    expect(() => book.seedHistoricalVolume(30, 999n, 9)).toThrow(/out of range/i);
    expect(() => book.seedHistoricalVolume(-1, 1n, 1)).toThrow(/out of range/i);
    // Ring intact → snapshot carries a length-24 array → survives round-trip.
    const snap = book.exportSnapshot("SEED");
    expect(snap.volumeBuckets!.length).toBe(24);
    const dst = OrderBook.create("SEEDb");
    dst.importSnapshot(snap);
    expect(dst.getStats24h().volume24h).toBe(100n); // seeded value preserved
  });
});

describe("instrument price-bounds enforcement", () => {
  test("add() rejects a price above maxPrice", () => {
    const book = boundedBook(); // max 100.00 = 10000n
    expect(() => helperAdd(book, new Order("hi", Side.SELL, 10001n, 1n))).toThrow(/valid range/);
  });

  test("add() rejects a price below minPrice", () => {
    const book = boundedBook(); // min 1.00 = 100n
    expect(() => helperAdd(book, new Order("lo", Side.BUY, 99n, 1n))).toThrow(/valid range/);
  });

  test("add() accepts prices at the inclusive bounds", () => {
    const book = boundedBook();
    expect(() => helperAdd(book, new Order("min", Side.BUY, 100n, 1n))).not.toThrow();
    expect(() => helperAdd(book, new Order("max", Side.SELL, 10000n, 1n))).not.toThrow();
  });

  test("replace() rejects moving a price out of bounds", () => {
    const book = boundedBook();
    helperAdd(book, new Order("o", Side.BUY, 5000n, 1n)); // sid 1, in range
    expect(() => book.replace(1n, 1n as Quantity, 20000n as Price)).toThrow(/valid range/);
  });

  test("default book (system-ceiling max) still accepts normal prices", () => {
    const book = OrderBook.create("DEF");
    expect(() => helperAdd(book, new Order("n", Side.BUY, 10000n, 5n))).not.toThrow();
  });
});
