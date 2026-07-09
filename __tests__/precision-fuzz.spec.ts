import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";
import { MAX_PRICE_VALUE, MAX_QUANTITY_VALUE } from "../src/constants";

// Helper to calculate filled quantity
const filledQty = (order: Order): bigint => order.orderQuantity - order.openQuantity;

describe("Precision Fuzz Tests", () => {
  test("large quantity matching preserves precision", () => {
    const book = OrderBook.create("PREC");

    // Large quantities near max
    const largeQty = MAX_QUANTITY_VALUE / 1000n; // 999,999,999,999

    const maker = new Order("maker", Side.SELL, 10000n, largeQty);
    helperAdd(book, maker);

    const taker = new Order("taker", Side.BUY, 10000n, largeQty);
    helperAdd(book, taker);

    // Both should be fully filled
    expect(filledQty(maker)).toBe(largeQty);
    expect(filledQty(taker)).toBe(largeQty);
    expect(maker.openQuantity).toBe(0n);
    expect(taker.openQuantity).toBe(0n);
  });

  test("partial fills with odd quantities", () => {
    const book = OrderBook.create("PREC");

    // Odd quantities that could cause precision issues in float systems
    const makerQty = 333_333_333_333n;
    const takerQty = 100_000_000_000n;

    const maker = new Order("maker", Side.SELL, 10000n, makerQty);
    helperAdd(book, maker);

    const taker = new Order("taker", Side.BUY, 10000n, takerQty);
    helperAdd(book, taker);

    // Taker fully filled, maker partially filled
    expect(filledQty(taker)).toBe(takerQty);
    expect(filledQty(maker)).toBe(takerQty);
    expect(maker.openQuantity).toBe(makerQty - takerQty);

    // Verify exact remaining
    expect(maker.openQuantity).toBe(233_333_333_333n);
  });

  test("many small fills sum correctly", () => {
    const book = OrderBook.create("PREC");

    // One large maker
    const makerQty = 1_000_000n;
    const maker = new Order("maker", Side.SELL, 10000n, makerQty);
    helperAdd(book, maker);

    // Many small takers
    const takerQty = 1n;
    for (let i = 0; i < 1000; i++) {
      const taker = new Order(`taker-${i}`, Side.BUY, 10000n, takerQty);
      helperAdd(book, taker);
    }

    // Maker should have exactly 1000 filled
    expect(filledQty(maker)).toBe(1000n);
    expect(maker.openQuantity).toBe(makerQty - 1000n);
  });

  test("price boundary values", () => {
    const book = OrderBook.create("PREC");

    // Test with max price value
    const maker = new Order("maker", Side.SELL, MAX_PRICE_VALUE, 100n);
    helperAdd(book, maker);

    const taker = new Order("taker", Side.BUY, MAX_PRICE_VALUE, 100n);
    helperAdd(book, taker);

    expect(filledQty(maker)).toBe(100n);
    expect(filledQty(taker)).toBe(100n);
  });

  test("quantity boundary values", () => {
    const book = OrderBook.create("PREC");

    // Test with max quantity value
    const maker = new Order("maker", Side.SELL, 10000n, MAX_QUANTITY_VALUE);
    helperAdd(book, maker);

    const taker = new Order("taker", Side.BUY, 10000n, MAX_QUANTITY_VALUE);
    helperAdd(book, taker);

    expect(filledQty(maker)).toBe(MAX_QUANTITY_VALUE);
    expect(filledQty(taker)).toBe(MAX_QUANTITY_VALUE);
  });

  test("multi-level sweep maintains precision", () => {
    const book = OrderBook.create("PREC");

    // Create multiple price levels with varying quantities
    const quantities = [
      123_456_789n,
      987_654_321n,
      111_111_111n,
      222_222_222n,
      333_333_333n,
    ];

    let totalMakerQty = 0n;
    for (let i = 0; i < quantities.length; i++) {
      const maker = new Order(`maker-${i}`, Side.SELL, 10000n + BigInt(i), quantities[i]);
      helperAdd(book, maker);
      totalMakerQty += quantities[i];
    }

    // Sweep all levels
    const taker = new Order("taker", Side.BUY, 10000n + BigInt(quantities.length), totalMakerQty);
    helperAdd(book, taker);

    // Taker should be fully filled with exact sum
    expect(filledQty(taker)).toBe(totalMakerQty);
    expect(taker.openQuantity).toBe(0n);
  });

  test("random quantity stress test", () => {
    const book = OrderBook.create("PREC");

    // Pseudo-random but deterministic quantities
    const seed = 12345n;
    const quantities: bigint[] = [];
    let current = seed;

    for (let i = 0; i < 100; i++) {
      current = (current * 1103515245n + 12345n) % (2n ** 31n);
      quantities.push(current % 1_000_000n + 1n); // 1 to 1,000,000
    }

    // Add makers
    let totalMakerQty = 0n;
    for (let i = 0; i < quantities.length; i++) {
      const maker = new Order(`maker-${i}`, Side.SELL, 10000n, quantities[i]);
      helperAdd(book, maker);
      totalMakerQty += quantities[i];
    }

    // Single taker sweeps all
    const taker = new Order("taker", Side.BUY, 10000n, totalMakerQty);
    helperAdd(book, taker);

    // Verify exact fill
    expect(filledQty(taker)).toBe(totalMakerQty);
    expect(taker.openQuantity).toBe(0n);
  });

  test("alternating buy/sell maintains book integrity", () => {
    const book = OrderBook.create("PREC");

    const qty = 1_000_000_000n;

    // Alternating buys and sells at same price
    for (let i = 0; i < 100; i++) {
      const side = i % 2 === 0 ? Side.BUY : Side.SELL;
      const order = new Order(`order-${i}`, side, 10000n, qty);
      helperAdd(book, order);
    }

    // Book should be empty (all matched)
    const depth = book.getDepth();
    expect(depth.bids.length).toBe(0);
    expect(depth.asks.length).toBe(0);
  });
});

// Solvency Fuzz - verify BigInt arithmetic correctness across random inputs
describe("Precision Fuzz (Solvency)", () => {
  function randInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  for (let i = 0; i < 100; i++) {
    test(`solvency-fuzz-${i}`, () => {
      const book = OrderBook.create(`FUZZ${i}`);

      // Random but bounded quantities and prices
      const makerPrice = BigInt(randInt(1000, 100000));
      const makerQty = BigInt(randInt(1, 10000));
      const takerQty = BigInt(randInt(1, 10000));

      // Add maker
      const maker = new Order(`maker-${i}`, Side.SELL, makerPrice, makerQty);
      helperAdd(book, maker);

      // Add taker at same or better price
      const taker = new Order(`taker-${i}`, Side.BUY, makerPrice, takerQty);
      helperAdd(book, taker);

      // Calculate expected fill
      const expectedFill = makerQty < takerQty ? makerQty : takerQty;
      const makerFilled = maker.orderQuantity - maker.openQuantity;
      const takerFilled = taker.orderQuantity - taker.openQuantity;

      // INVARIANT 1: Fills must match exactly
      expect(makerFilled).toBe(takerFilled);

      // INVARIANT 2: Fill cannot exceed either order's quantity
      expect(makerFilled <= makerQty).toBe(true);
      expect(takerFilled <= takerQty).toBe(true);

      // INVARIANT 3: Fill should be the minimum of the two quantities
      expect(makerFilled).toBe(expectedFill);

      // INVARIANT 4: No negative quantities
      expect(maker.openQuantity >= 0n).toBe(true);
      expect(taker.openQuantity >= 0n).toBe(true);
    });
  }
});
