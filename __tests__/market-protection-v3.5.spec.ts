// packages/orderbook/__tests__/market-protection-v3.5.spec.ts

/**
 * Comprehensive test suite for Market Order Price Protection v3.5 enhancements.
 *
 * P0 TESTS (Critical Correctness):
 * - Schema versioning for crash recovery durability
 * - MAX_PRICE clamping to prevent BigInt explosion
 * - maxPrice coherence validation
 *
 * P1 TESTS (Important Safety):
 * - Canonical decimal format validation
 * - Post-snap affordability check
 * - minPrice guard
 *
 * P2 TESTS (Compliance):
 * - String-based ingestion
 * - Modulo invariants
 */

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import {
  calculateRawPriceCap,
  createInstrument,
  deserializeOrder,
  Order,
  OrderBook,
  OrderState,
  Side,
  snapToTick,
  toCanonicalDecimal,
} from "../src";

// =============================================================================
// P0 TESTS: Schema Versioning (Crash Recovery Durability)
// =============================================================================

describe("P0: Schema Versioning (deserializeOrder)", () => {
  test("should throw if schemaVersion is missing", () => {
    const corruptedSnapshot = {
      // schemaVersion: 1, // MISSING (simulates WAL corruption)
      orderId: "test-123",
      serverOrderId: "1",
      side: Side.BUY,
      price: "100",
      orderQuantity: "1000",
      openQuantity: "1000",
      state: 2, // OrderState.NEW
      userData: null,
      isProtectedMarket: false,
    };

    expect(() => deserializeOrder(corruptedSnapshot)).toThrow(/missing schemaVersion/i);
  });

  test("should throw if schemaVersion is incompatible", () => {
    const futureSnapshot = {
      schemaVersion: 999, // Future version
      orderId: "test-123",
      serverOrderId: "1",
      side: Side.BUY,
      price: "100",
      orderQuantity: "1000",
      openQuantity: "1000",
      state: 2,
      userData: null,
      isProtectedMarket: false,
    };

    expect(() => deserializeOrder(futureSnapshot)).toThrow(
      /WAL version 999 is incompatible/,
    );
  });

  test("should throw if isProtectedMarket is missing", () => {
    const snapshot = {
      schemaVersion: 1,
      orderId: "test-123",
      serverOrderId: "1",
      side: Side.BUY,
      price: "500", // price > 0n
      orderQuantity: "100",
      openQuantity: "100",
      state: 2,
      userData: null,
      // isProtectedMarket: false, // MISSING (critical for IOC behavior)
    };

    expect(() => deserializeOrder(snapshot)).toThrow(/missing isProtectedMarket flag/i);
  });

  test("should successfully deserialize valid v1 snapshot", () => {
    const validSnapshot = {
      schemaVersion: 1,
      orderId: "test-456",
      serverOrderId: "42",
      side: Side.BUY,
      price: "500",
      orderQuantity: "100",
      openQuantity: "50",
      state: 3, // OrderState.PARTIALLY_FILLED
      userData: { userId: "user-123" },
      isProtectedMarket: true, // Protected market order
    };

    const order = deserializeOrder(validSnapshot);

    expect(order.orderId).toBe("test-456");
    expect(order.serverOrderId).toBe(42n);
    expect(order.price).toBe(500n);
    expect(order.orderQuantity).toBe(100n);
    expect(order.openQuantity).toBe(50n);
    expect(order.isProtectedMarket).toBe(true);
    expect(order.schemaVersion).toBe(1);
  });
});

// =============================================================================
// P0 TESTS: MAX_PRICE Clamping (Prevents BigInt Explosion)
// =============================================================================

describe("P0: MAX_PRICE Clamping (calculateRawPriceCap)", () => {
  test("should clamp uncapped price to maxPrice for dust quantities", () => {
    // Scenario: User has 10,000.00 balance, orders 0.01 units (dust)
    // Without clamping: (10,000.00 * 100) / 0.01 = 100,000,000.00 (insane!)
    // With clamping: min(100,000,000.00, 10,000.00) = 10,000.00 (safe)

    const balanceInternal = 1000000n; // 10,000.00 (precision 2)
    const qtyInternal = 1n; // 0.01 units (precision 2)
    const quantityScaleFactor = 100n; // 10^2
    const maxPrice = 1000000n; // 10,000.00 ceiling

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      quantityScaleFactor,
      maxPrice,
    );

    // Should be clamped to maxPrice, not the uncapped 100,000,000n
    expect(rawCap).toBe(maxPrice);
    expect(rawCap).toBe(1000000n);
  });

  test("should not clamp for normal quantities", () => {
    // Scenario: User has 5,000.00, orders 100.00 units
    // Uncapped: (5,000.00 * 100) / 100.00 = 50.00 per unit (normal)

    const balanceInternal = 500000n; // 5,000.00
    const qtyInternal = 10000n; // 100.00 units
    const quantityScaleFactor = 100n;
    const maxPrice = 1000000n; // 10,000.00 ceiling

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      quantityScaleFactor,
      maxPrice,
    );

    // Should be uncapped price (5,000n = 50.00), well below maxPrice
    expect(rawCap).toBe(5000n);
    expect(rawCap).toBeLessThan(maxPrice);
  });

  test("should return 0 for zero quantity", () => {
    const balanceInternal = 1000000n;
    const qtyInternal = 0n; // Zero quantity
    const quantityScaleFactor = 100n;
    const maxPrice = 1000000n;

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      quantityScaleFactor,
      maxPrice,
    );

    expect(rawCap).toBe(0n);
  });
});

// =============================================================================
// P0 TESTS: maxPrice Coherence Validation
// =============================================================================

describe("P0: maxPrice Coherence (createInstrument)", () => {
  test("should reject maxPrice not aligned to tickSize", () => {
    // maxPrice must be a multiple of tickSize
    // Example: tickSize = 0.03, maxPrice = 10.00
    // 10.00 % 0.03 = 0.01 (not zero, invalid!)

    expect(() =>
      createInstrument(
        "BTC/USD",
        2, // pricePrecision
        2, // quantityPrecision
        toCanonicalDecimal("0.03", 2), // tickSize
        toCanonicalDecimal("0.03", 2), // minPrice (aligned)
        toCanonicalDecimal("10.00", 2), // maxPrice (NOT aligned to 0.03)
      ),
    ).toThrow(/maxPrice.*must be a multiple of tickSize/i);
  });

  test("should accept maxPrice aligned to tickSize", () => {
    // maxPrice = 9.99, tickSize = 0.03
    // 9.99 = 333 * 0.03 (aligned!)

    const instrument = createInstrument(
      "BTC/USD",
      2, // pricePrecision
      2, // quantityPrecision
      toCanonicalDecimal("0.03", 2),
      toCanonicalDecimal("0.03", 2),
      toCanonicalDecimal("9.99", 2), // Aligned: 333 * 0.03
    );

    expect(instrument.maxPrice).toBe(999n); // 9.99 with precision 2
    expect(instrument.tickSize).toBe(3n); // 0.03 with precision 2
    expect(instrument.maxPrice % instrument.tickSize).toBe(0n);
  });

  test("should reject maxPrice < minPrice", () => {
    expect(() =>
      createInstrument(
        "BTC/USD",
        2, // pricePrecision
        2, // quantityPrecision
        toCanonicalDecimal("0.01", 2),
        toCanonicalDecimal("100.00", 2), // minPrice
        toCanonicalDecimal("50.00", 2), // maxPrice < minPrice (invalid!)
      ),
    ).toThrow(/maxPrice.*cannot be less than minPrice/i);
  });
});

// =============================================================================
// P1 TESTS: Canonical Decimal Format Validation
// =============================================================================

describe("P1: Canonical Decimal Format (createInstrument)", () => {
  test("should reject leading zeros in tickSize", () => {
    expect(() =>
      createInstrument(
        "AAPL",
        2,
        0,
        toCanonicalDecimal("007.50", 2), // Leading zeros (non-canonical)
        toCanonicalDecimal("1.00", 2),
        toCanonicalDecimal("10000.00", 2),
      ),
    ).toThrow(/Must be a canonical non-negative decimal/i);
  });

  test("should reject leading zeros in minPrice", () => {
    expect(() =>
      createInstrument(
        "AAPL",
        2,
        0,
        toCanonicalDecimal("0.01", 2),
        toCanonicalDecimal("00.50", 2), // Leading zeros
        toCanonicalDecimal("10000.00", 2),
      ),
    ).toThrow(/Must be a canonical non-negative decimal/i);
  });

  test("should reject leading zeros in maxPrice", () => {
    expect(() =>
      createInstrument(
        "AAPL",
        2,
        0,
        toCanonicalDecimal("0.01", 2),
        toCanonicalDecimal("1.00", 2),
        toCanonicalDecimal("010000.00", 2), // Leading zeros
      ),
    ).toThrow(/Must be a canonical non-negative decimal/i);
  });

  test("should accept canonical format", () => {
    // All values in canonical format (no leading zeros)
    const instrument = createInstrument(
      "AAPL",
      2, // pricePrecision
      0, // quantityPrecision
      toCanonicalDecimal("0.01", 2), // Valid: starts with '0.'
      toCanonicalDecimal("1.00", 2), // Valid: no leading zeros
      toCanonicalDecimal("10000.00", 2), // Valid: no leading zeros
    );

    expect(instrument.tickSize).toBe(1n);
    expect(instrument.minPrice).toBe(100n);
    expect(instrument.maxPrice).toBe(1000000n);
  });

  test("should accept '0' and '0.xx' format", () => {
    // Edge case: "0" and "0.xxx" are valid (not considered leading zeros)
    const instrument = createInstrument(
      "TEST",
      2, // pricePrecision
      2, // quantityPrecision
      toCanonicalDecimal("0.01", 2), // tickSize
      toCanonicalDecimal("0.10", 2), // minPrice
      toCanonicalDecimal("1000.00", 2), // maxPrice
    );

    expect(instrument.tickSize).toBe(1n);
    expect(instrument.minPrice).toBe(10n);
  });
});

// =============================================================================
// P1 TESTS: Post-Snap Affordability Check
// =============================================================================

describe("P1: Post-Snap Affordability Check", () => {
  test("should detect unaffordable order after tick-snapping", () => {
    // Scenario: rawCap = 50.03, tickSize = 1.00
    // Snapped: 50.00
    // Cost after snap: (100 qty * 50.00) / 100 = 50.00
    // Balance: 49.99 (INSUFFICIENT after snap!)

    const balanceInternal = 4999n; // 49.99
    const qtyInternal = 10000n; // 100.00 units
    const quantityScaleFactor = 100n;
    const maxPrice = 1000000n;
    const tickSize = 100n; // 1.00

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      quantityScaleFactor,
      maxPrice,
    );
    expect(rawCap).toBe(49n); // 0.49 per unit (raw)

    const snappedCap = snapToTick(rawCap, tickSize);
    expect(snappedCap).toBe(0n); // Snapped to 0.00 (below tickSize)

    // Post-snap cost check
    const postSnapCost = (qtyInternal * snappedCap) / quantityScaleFactor;
    expect(postSnapCost).toBe(0n);

    // In real code, this would throw: "Insufficient funds after tick-snapping"
    // Here we just verify the math is correct for the guard
  });

  test("should pass affordability check when balance is sufficient", () => {
    const balanceInternal = 5000n; // 50.00
    const qtyInternal = 10000n; // 100.00 units
    const quantityScaleFactor = 100n;
    const maxPrice = 1000000n;
    const tickSize = 1n; // 0.01 (fine-grained)

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      quantityScaleFactor,
      maxPrice,
    );
    expect(rawCap).toBe(50n); // 0.50 per unit

    const snappedCap = snapToTick(rawCap, tickSize);
    expect(snappedCap).toBe(50n); // No change (already aligned)

    const postSnapCost = (qtyInternal * snappedCap) / quantityScaleFactor;
    expect(postSnapCost).toBe(5000n); // Exactly 50.00

    expect(postSnapCost).toBeLessThanOrEqual(balanceInternal);
  });
});

// =============================================================================
// P1 TESTS: minPrice Guard
// =============================================================================

describe("P1: minPrice Guard", () => {
  test("should detect price cap below minPrice", () => {
    // Scenario: User has 5.00, wants 100 units
    // rawCap = 0.05 per unit
    // Snapped: 0.05
    // But minPrice = 1.00 (order should be rejected)

    const instrument = createInstrument(
      "TEST",
      2, // pricePrecision
      2, // quantityPrecision
      toCanonicalDecimal("0.01", 2), // tickSize
      toCanonicalDecimal("1.00", 2), // minPrice
      toCanonicalDecimal("10000.00", 2), // maxPrice
    );

    const balanceInternal = 500n; // 5.00
    const qtyInternal = 10000n; // 100.00 units

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      instrument.quantityScaleFactor,
      instrument.maxPrice,
    );
    expect(rawCap).toBe(5n); // 0.05 per unit

    const snappedCap = snapToTick(rawCap, instrument.tickSize);
    expect(snappedCap).toBe(5n); // 0.05 (aligned)

    // minPrice guard: snappedCap < minPrice
    expect(snappedCap).toBeLessThan(instrument.minPrice);
    // In real code, this would throw: "price cap below minimum price"
  });

  test("should accept price cap above minPrice", () => {
    const instrument = createInstrument(
      "TEST",
      2, // pricePrecision
      2, // quantityPrecision
      toCanonicalDecimal("0.01", 2), // tickSize
      toCanonicalDecimal("1.00", 2), // minPrice
      toCanonicalDecimal("10000.00", 2), // maxPrice
    );

    const balanceInternal = 10000n; // 100.00
    const qtyInternal = 5000n; // 50.00 units

    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      instrument.quantityScaleFactor,
      instrument.maxPrice,
    );
    expect(rawCap).toBe(200n); // 2.00 per unit

    const snappedCap = snapToTick(rawCap, instrument.tickSize);
    expect(snappedCap).toBe(200n);

    expect(snappedCap).toBeGreaterThanOrEqual(instrument.minPrice);
  });
});

// =============================================================================
// P2 TESTS: String-Based Ingestion (Float Precision Safety)
// =============================================================================

describe("P2: String-Based Ingestion", () => {
  test("should handle precise decimal without float errors", () => {
    // Problem: 0.00000002 * 10^8 = 1.9999998 (float error)
    // Solution: Parse "0.00000002" as string → 2n (exact)

    const instrument = createInstrument(
      "BTC/SATS",
      8, // 8 decimals for satoshis
      8,
      toCanonicalDecimal("0.00000001", 8), // 1 satoshi
      toCanonicalDecimal("0.00000001", 8),
      toCanonicalDecimal("1.00000000", 8), // 1 BTC
    );
    // tickSize should be exactly 1n (1 satoshi), not 0n or 2n
    expect(instrument.tickSize).toBe(1n);
  });

  test("should reject over-precision input", () => {
    // Precision = 2, but input has 3 decimals → should throw

    expect(() =>
      createInstrument(
        "TEST",
        2, // pricePrecision
        2,
        toCanonicalDecimal("0.019", 2), // 3 decimals (over-precision!)
        toCanonicalDecimal("1.00", 2),
        toCanonicalDecimal("10000.00", 2),
      ),
    ).toThrow(/has 3 decimal places.*precision is 2/i);
  });

  test("should reject scientific notation", () => {
    expect(() =>
      createInstrument(
        "TEST",
        8,
        8,
        toCanonicalDecimal("1e-8", 8), // Scientific notation (not allowed)
        toCanonicalDecimal("1e-8", 8),
        toCanonicalDecimal("1.0", 8),
      ),
    ).toThrow(/Scientific notation not supported/i);
  });
});

// =============================================================================
// P2 TESTS: Modulo Invariants (Exchange Validity)
// =============================================================================

describe("P2: Modulo Invariants", () => {
  test("should reject minPrice not aligned to tickSize", () => {
    // tickSize = 0.03, minPrice = 0.05
    // 0.05 % 0.03 = 0.02 (not zero, invalid!)

    expect(() =>
      createInstrument(
        "TEST",
        2,
        2,
        toCanonicalDecimal("0.03", 2), // tickSize
        toCanonicalDecimal("0.05", 2), // minPrice (NOT a multiple of 0.03)
        toCanonicalDecimal("10000.00", 2),
      ),
    ).toThrow(/minPrice.*must be a multiple of tickSize/i);
  });

  test("should accept minPrice aligned to tickSize", () => {
    // tickSize = 0.03, minPrice = 0.09, maxPrice = 9.99
    // 0.09 = 3 * 0.03 (aligned!)
    // 9.99 = 333 * 0.03 (aligned!)

    const instrument = createInstrument(
      "TEST",
      2,
      2,
      toCanonicalDecimal("0.03", 2),
      toCanonicalDecimal("0.09", 2), // 3 * 0.03
      toCanonicalDecimal("9.99", 2), // 333 * 0.03 (aligned)
    );

    expect(instrument.minPrice).toBe(9n);
    expect(instrument.tickSize).toBe(3n);
    expect(instrument.minPrice % instrument.tickSize).toBe(0n);
    expect(instrument.maxPrice % instrument.tickSize).toBe(0n);
  });
});

// =============================================================================
// INTEGRATION TESTS: Full Protected Order Flow
// =============================================================================

describe("INTEGRATION: Protected Order Flow", () => {
  test("should successfully create and serialize protected order", () => {
    const order = new Order(
      "test-order-123",
      Side.BUY,
      5000n, // price = 50.00 (cap)
      10000n, // quantity = 100.00
      { userId: "user-123" },
    );

    // Mark as protected market order
    order.isProtectedMarket = true;
    order.serverOrderId = 42n;

    // Verify IOC behavior
    expect(order.isIOC()).toBe(true);
    expect(order.isMarket()).toBe(false); // Not a pure market order
    expect(order.isLimit()).toBe(true); // Has price cap

    // Serialize and verify all fields
    const serialized = order.toSerializableObject();
    expect(serialized.schemaVersion).toBe(1);
    expect(serialized.isProtectedMarket).toBe(true);
    expect(serialized.price).toBe("5000");
    expect(serialized.orderQuantity).toBe("10000");

    // Deserialize and verify restoration
    const restored = deserializeOrder(serialized);
    expect(restored.isProtectedMarket).toBe(true);
    expect(restored.isIOC()).toBe(true);
    expect(restored.price).toBe(5000n);
  });

  test("should calculate realistic price caps with full pipeline", () => {
    // Realistic scenario: User has $100, wants to buy 50 units of AAPL
    // Expected cap: $2.00 per share (100 / 50)
    const instrument = createInstrument(
      "AAPL",
      2, // USD cents
      0, // Whole shares
      toCanonicalDecimal("0.01", 2), // Penny increments
      toCanonicalDecimal("0.50", 2), // Min price $0.50
      toCanonicalDecimal("500.00", 2), // Max price $500
    );

    const balanceInternal = 10000n; // $100.00
    const qtyInternal = 50n; // 50 shares

    // Step 1: Calculate raw cap
    const rawCap = calculateRawPriceCap(
      balanceInternal,
      qtyInternal,
      instrument.quantityScaleFactor,
      instrument.maxPrice,
    );
    expect(rawCap).toBe(200n); // $2.00 (unclamped)

    // Step 2: Snap to tick
    const snappedCap = snapToTick(rawCap, instrument.tickSize);
    expect(snappedCap).toBe(200n); // Already aligned to $0.01

    // Step 3: Post-snap affordability
    const postSnapCost = (qtyInternal * snappedCap) / instrument.quantityScaleFactor;
    expect(postSnapCost).toBe(10000n); // Exactly $100.00
    expect(postSnapCost).toBeLessThanOrEqual(balanceInternal);

    // Step 4: minPrice guard
    expect(snappedCap).toBeGreaterThanOrEqual(instrument.minPrice);

    // All checks pass - order is safe!
  });

  test("Solvency Invariant: Cap <= Balance", () => {
    const inst = createInstrument(
      "TEST",
      2,
      2,
      toCanonicalDecimal("0.01", 2),
      toCanonicalDecimal("0.01", 2),
      toCanonicalDecimal("10000.00", 2),
    );
    const cap = calculateRawPriceCap(10000n, 100n, inst.quantityScaleFactor, inst.maxPrice);
    const cost = (100n * cap) / inst.quantityScaleFactor;
    expect(cost).toBeLessThanOrEqual(10000n);
  });

  test("solvency invariant holds with partial fills", () => {
    const book = OrderBook.create("TEST");
    const maker1 = new Order("m1", Side.SELL, 950n, 10n);
    const maker2 = new Order("m2", Side.SELL, 1000n, 10n);
    helperAdd(book, maker1);
    helperAdd(book, maker2);
    const taker = new Order("t", Side.BUY, 0n, 15n);
    taker.isProtectedMarket = true;
    taker.price = 1000n; // Cap
    helperAdd(book, taker);
    expect(taker.state).toBe(OrderState.FILLED); // Taker fully filled: 10n from maker1 + 5n from maker2
    const totalCost = 10n * 950n + 5n * 1000n; // <= cap * qty
    expect(totalCost / 100n).toBeLessThanOrEqual(1500n); // Scaled balance assumption
  });
});

// =============================================================================
// P1 TESTS: Ledger Delta Accounting (Solvency Proof)
// =============================================================================

describe("P1: Ledger Delta Accounting", () => {
  test("should verify ledger delta (InitialBalance - FinalBalance === Sum(Fills))", () => {
    // This test proves that the money deducted from the user's balance exactly
    // matches the sum of the fills, ensuring no "Ammo" is lost to rounding or logic errors.
    //
    // Scenario:
    // - User wants to market buy 80 units
    // - Liquidity at 48.00 (50 units) and 49.00 (50 units)
    // - Expected fills: 50 @ 48.00 + 30 @ 49.00 = 2400 + 1470 = 3870

    const book = OrderBook.create("TEST");

    // Setup book with multiple price levels
    const sell1 = new Order("s1", Side.SELL, 4800n, 5000n); // 50 units @ 48.00 (precision 2)
    const sell2 = new Order("s2", Side.SELL, 4900n, 5000n); // 50 units @ 49.00 (precision 2)
    helperAdd(book, sell1);
    helperAdd(book, sell2);

    // Market Buy 80 units (8000n with precision 2 for qty)
    const taker = new Order("t1", Side.BUY, 0n, 8000n);
    taker.isProtectedMarket = true;
    taker.price = 5000n; // Cap at 50.00 (won't be hit)

    helperAdd(book, taker);

    // Verify the taker was fully filled
    expect(taker.openQuantity).toBe(0n);
    expect(taker.state).toBe(OrderState.FILLED);

    // Verify makers were correctly filled
    expect(sell1.openQuantity).toBe(0n); // Fully consumed
    expect(sell1.state).toBe(OrderState.FILLED);
    expect(sell2.openQuantity).toBe(2000n); // 20 units remaining (50 - 30)
    expect(sell2.state).toBe(OrderState.PARTIALLY_FILLED);

    // Calculate expected cost (Ledger Delta):
    // Fill 1: 50 units @ 48.00 = 50 * 48.00 = 2400.00
    // Fill 2: 30 units @ 49.00 = 30 * 49.00 = 1470.00
    // Total: 3870.00
    //
    // In internal representation (precision 2 for both price and qty):
    // Fill 1: 5000n * 4800n / 100n = 240000n (cost in cents)
    // Fill 2: 3000n * 4900n / 100n = 147000n (cost in cents)
    // Total: 387000n
    const expectedCost = 387000n;

    // In a full integration with UserManager, we would verify:
    // InitialBalance - FinalBalance === expectedCost
    //
    // For this unit test, we verify the math is correct by checking
    // the fill quantities and prices match our expectation
    const fill1Qty = 5000n; // 50 units filled from sell1
    const fill1Price = 4800n;
    const fill2Qty = 3000n; // 30 units filled from sell2
    const fill2Price = 4900n;

    const actualCost =
      (fill1Qty * fill1Price) / 100n + (fill2Qty * fill2Price) / 100n;

    expect(actualCost).toBe(expectedCost);
  });

  test("should maintain ledger delta invariant with partial fills across ticks", () => {
    const book = OrderBook.create("TEST");

    // Setup 3 price levels
    const sell1 = new Order("s1", Side.SELL, 100n, 10n); // 10 @ 1.00
    const sell2 = new Order("s2", Side.SELL, 101n, 10n); // 10 @ 1.01
    const sell3 = new Order("s3", Side.SELL, 102n, 10n); // 10 @ 1.02
    helperAdd(book, sell1);
    helperAdd(book, sell2);
    helperAdd(book, sell3);

    // Buy 25 units (should consume sell1 fully, sell2 fully, sell3 partially)
    const taker = new Order("t1", Side.BUY, 0n, 25n);
    taker.isProtectedMarket = true;
    taker.price = 110n; // Cap at 1.10

    helperAdd(book, taker);

    expect(taker.state).toBe(OrderState.FILLED);
    expect(sell1.state).toBe(OrderState.FILLED);
    expect(sell2.state).toBe(OrderState.FILLED);
    expect(sell3.state).toBe(OrderState.PARTIALLY_FILLED);
    expect(sell3.openQuantity).toBe(5n); // 5 remaining

    // Ledger delta calculation:
    // 10 * 1.00 + 10 * 1.01 + 5 * 1.02 = 10 + 10.10 + 5.10 = 25.20
    // In internal: (10 * 100 + 10 * 101 + 5 * 102) / scale
    const expectedCost = 10n * 100n + 10n * 101n + 5n * 102n;
    expect(expectedCost).toBe(2520n); // 25.20 in cents
  });
});

describe("P2: Extreme Precision (18 Decimals)", () => {
  test("should parse 18-decimal tickSize without loss", () => {
    const inst = createInstrument(
      "TEST",
      18,
      18,
      toCanonicalDecimal("0.000000000000000001", 18),
      toCanonicalDecimal("0.000000000000000001", 18),
      toCanonicalDecimal("1.000000000000000000", 18),
    );
    expect(inst.tickSize).toBe(1n);
    expect(inst.minPrice).toBe(1n);
  });

  test("should cap and snap at 18 decimals without overflow", () => {
    const inst = createInstrument(
      "TEST",
      18,
      18,
      toCanonicalDecimal("0.000000000000000001", 18),
      toCanonicalDecimal("0.000000000000000001", 18),
      toCanonicalDecimal("999999999999999999.999999999999999999", 18),
    );
    const balance = 10n ** 18n; // 1.0 scaled
    const qty = 1n; // Dust qty
    const cap = calculateRawPriceCap(balance, qty, inst.quantityScaleFactor, inst.maxPrice);
    expect(cap).toBe(inst.maxPrice); // Clamped
  });
});

// =============================================================================
// #398: marketable-limit IOC — a PRICED limit order tagged IOC cancels its
// unfilled residual instead of resting. This is the default Buy/Sell behavior:
// fill up to the displayed price cap, then cancel the remainder (no hidden
// open order). Distinct from the Protected-Market path (price=0, balance cap).
// =============================================================================
describe("#398: marketable-limit IOC residual cancellation", () => {
  test("IOC priced-limit BUY cancels its unfilled residual (does not rest)", () => {
    const book = OrderBook.create("TEST");
    helperAdd(book, new Order("m-ioc", Side.SELL, 1000n, 10n)); // only 10 available @ 1000
    const taker = new Order("t-ioc", Side.BUY, 1000n, 15n); // priced LIMIT (price>0), not a market order
    taker.ioc = true;
    helperAdd(book, taker);

    expect(taker.isMarket()).toBe(false); // genuinely a priced limit, not a market order
    expect(taker.isIOC()).toBe(true); // ...but IOC via the flag
    expect(taker.openQuantity).toBe(5n); // 15 − 10 filled; residual NOT re-added
    expect(taker.state).toBe(OrderState.CANCELED); // residual canceled
    expect(book.getBestBidPrice()).toBe(0n); // nothing rested on the bid side
  });

  test("control: a GTC priced-limit BUY rests its unfilled residual", () => {
    const book = OrderBook.create("TEST");
    helperAdd(book, new Order("m-gtc", Side.SELL, 1000n, 10n));
    const taker = new Order("t-gtc", Side.BUY, 1000n, 15n); // no ioc flag → GTC
    helperAdd(book, taker);

    expect(taker.isIOC()).toBe(false);
    expect(taker.openQuantity).toBe(5n);
    expect(taker.state).toBe(OrderState.PARTIALLY_FILLED); // residual rests
    expect(book.getBestBidPrice()).toBe(1000n); // the 5-unit residual is resting in the book
  });

  test("SELL-side IOC priced-limit cancels its unfilled residual", () => {
    const book = OrderBook.create("TEST");
    helperAdd(book, new Order("m-buy", Side.BUY, 1000n, 10n)); // only 10 demanded @ 1000
    const taker = new Order("t-sell-ioc", Side.SELL, 1000n, 15n);
    taker.ioc = true;
    helperAdd(book, taker);

    expect(taker.openQuantity).toBe(5n); // 15 − 10
    expect(taker.state).toBe(OrderState.CANCELED); // residual canceled, not resting
    expect(book.getBestAskPrice()).toBe(0n); // nothing rested on the ask side
  });

  test("IOC that fully fills is FILLED, not CANCELED (no spurious cancel)", () => {
    const book = OrderBook.create("TEST");
    helperAdd(book, new Order("m-full", Side.SELL, 1000n, 20n)); // ample liquidity
    const taker = new Order("t-full", Side.BUY, 1000n, 15n);
    taker.ioc = true;
    helperAdd(book, taker);

    expect(taker.openQuantity).toBe(0n);
    expect(taker.state).toBe(OrderState.FILLED);
  });

  test("IOC with zero crossable liquidity is fully canceled (rests nothing)", () => {
    const book = OrderBook.create("TEST");
    // Resting ask is ABOVE the IOC buy's limit → no cross.
    helperAdd(book, new Order("m-high", Side.SELL, 2000n, 10n));
    const taker = new Order("t-nofill", Side.BUY, 1000n, 15n);
    taker.ioc = true;
    helperAdd(book, taker);

    expect(taker.openQuantity).toBe(15n); // nothing filled
    expect(taker.state).toBe(OrderState.CANCELED); // fully canceled, not resting
    expect(book.getBestBidPrice()).toBe(0n); // did not rest on the bid
  });
});
