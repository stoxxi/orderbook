// tests/matchingResult.spec.ts — Phase 1: MatchingResult return value tests

import { beforeEach, describe, expect, it } from "bun:test";
import { helperAdd } from "./_helpers";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

describe("OrderBook.add() → MatchingResult", () => {
  let orderBook: OrderBook;
  let instrument: Instrument;

  beforeEach(() => {
    instrument = createInstrument(
      "TEST",
      2,
      0,
      toCanonicalDecimal("0.01", 2), // tickSize
      toCanonicalDecimal("0.01", 2), // minPrice
      toCanonicalDecimal("1000000.00", 2), // maxPrice
    );
    orderBook = new OrderBook(instrument, noOpLogger, noOpMetrics);
  });

  describe("RESTING", () => {
    it("should return RESTING for a limit BUY on empty book", () => {
      const order = new Order("buy-1", Side.BUY, 5000n, 10n); // $50.00 x 10
      const result = helperAdd(orderBook, order);

      expect(result.status).toBe("RESTING");
      expect(result.fills).toHaveLength(0);
      expect(result.remainingQuantity).toBe(10n);
      expect(result.serverOrderId).toBeDefined();
    });

    it("should return RESTING for a limit SELL on empty book", () => {
      const order = new Order("sell-1", Side.SELL, 5000n, 20n);
      const result = helperAdd(orderBook, order);

      expect(result.status).toBe("RESTING");
      expect(result.fills).toHaveLength(0);
      expect(result.remainingQuantity).toBe(20n);
    });

    it("should return RESTING when prices don't cross", () => {
      // Sell at $60
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 6000n, 10n));
      // Buy at $50 — doesn't cross
      const result = helperAdd(orderBook, new Order("buy-1", Side.BUY, 5000n, 10n));

      expect(result.status).toBe("RESTING");
      expect(result.fills).toHaveLength(0);
      expect(result.remainingQuantity).toBe(10n);
    });
  });

  describe("FILLED — full fill", () => {
    it("should return FILLED with correct fills for a full match", () => {
      // Resting sell at $50
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 5000n, 10n));

      // Incoming buy at $50 for 10 shares — full fill
      const result = helperAdd(orderBook, new Order("buy-1", Side.BUY, 5000n, 10n));

      expect(result.status).toBe("FILLED");
      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].price).toBe(5000n);
      expect(result.fills[0].quantity).toBe(10n);
      expect(result.remainingQuantity).toBe(0n);
    });

    it("should return FILLED sweeping multiple price levels", () => {
      // Three sells at different prices
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 5000n, 5n)); // $50 x 5
      helperAdd(orderBook, new Order("sell-2", Side.SELL, 5100n, 5n)); // $51 x 5
      helperAdd(orderBook, new Order("sell-3", Side.SELL, 5200n, 5n)); // $52 x 5

      // Buy 12 shares at $52 — sweeps first two levels fully + 2 from third
      const result = helperAdd(orderBook, new Order("buy-1", Side.BUY, 5200n, 12n));

      expect(result.status).toBe("FILLED");
      expect(result.fills).toHaveLength(3);

      // Price-time priority: fills from lowest ask first
      expect(result.fills[0]).toEqual({ price: 5000n, quantity: 5n });
      expect(result.fills[1]).toEqual({ price: 5100n, quantity: 5n });
      expect(result.fills[2]).toEqual({ price: 5200n, quantity: 2n });
      expect(result.remainingQuantity).toBe(0n);
    });
  });

  describe("RESTING — partial fill with resting remainder (GTC limit)", () => {
    // SEMANTIC CHANGE: status now reflects the order's FINAL state (resting),
    // not fills.length. Previously any fills ⇒ "FILLED" even though the
    // remainder rested on the book.
    it("should return RESTING with fills and remainingQuantity > 0 for partial fill", () => {
      // Only 5 shares available at $50
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 5000n, 5n));

      // Buy 10 shares — only 5 fill, 5 rest
      const buy = new Order("buy-1", Side.BUY, 5000n, 10n);
      const result = helperAdd(orderBook, buy);

      expect(result.status).toBe("RESTING");
      expect(result.fills).toHaveLength(1);
      expect(result.fills[0]).toEqual({ price: 5000n, quantity: 5n });
      expect(result.remainingQuantity).toBe(5n); // 5 shares resting
      // The order genuinely rests: still in the book, PARTIALLY_FILLED
      expect(orderBook.status(buy.serverOrderId!)).toBe(OrderState.PARTIALLY_FILLED);
    });
  });

  describe("CANCELED — IOC residual canceled", () => {
    it("should return CANCELED for a zero-fill market order on an empty book", () => {
      // No liquidity at all — market buy fills nothing, IOC cancels everything
      const marketBuy = new Order("market-buy-0", Side.BUY, 0n, 10n);
      const result = helperAdd(orderBook, marketBuy);

      expect(result.status).toBe("CANCELED");
      expect(result.fills).toHaveLength(0);
      expect(result.remainingQuantity).toBe(10n); // entire qty canceled, nothing placed
      // The order is GONE from the book — there is nothing resting
      expect(orderBook.status(marketBuy.serverOrderId!)).toBeUndefined();
    });

    it("should return CANCELED for market order partial fill (IOC residual canceled)", () => {
      // 5 shares at $50
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 5000n, 5n));

      // Market buy for 10 — fills 5, residual canceled as IOC
      const marketBuy = new Order("market-buy", Side.BUY, 0n, 10n);
      const result = helperAdd(orderBook, marketBuy);

      expect(result.status).toBe("CANCELED");
      expect(result.fills).toHaveLength(1);
      expect(result.fills[0]).toEqual({ price: 5000n, quantity: 5n });
      expect(result.remainingQuantity).toBe(5n); // canceled residual, NOT resting
      expect(orderBook.status(marketBuy.serverOrderId!)).toBeUndefined();
    });

    it("should return CANCELED for limit-IOC partial fill (#409 time-in-force)", () => {
      // 5 shares at $50
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 5000n, 5n));

      // Limit buy @ $50 for 10 with IOC — fills 5, residual canceled
      const iocBuy = new Order("ioc-buy", Side.BUY, 5000n, 10n);
      iocBuy.ioc = true;
      const result = helperAdd(orderBook, iocBuy);

      expect(result.status).toBe("CANCELED");
      expect(result.fills).toHaveLength(1);
      expect(result.fills[0]).toEqual({ price: 5000n, quantity: 5n });
      expect(result.remainingQuantity).toBe(5n);
      expect(orderBook.status(iocBuy.serverOrderId!)).toBeUndefined();
    });

    it("should return CANCELED for zero-fill limit-IOC (no cross)", () => {
      // Ask at $60; IOC buy at $50 doesn't cross → zero fills, all canceled
      helperAdd(orderBook, new Order("sell-1", Side.SELL, 6000n, 10n));

      const iocBuy = new Order("ioc-buy-0", Side.BUY, 5000n, 10n);
      iocBuy.ioc = true;
      const result = helperAdd(orderBook, iocBuy);

      expect(result.status).toBe("CANCELED");
      expect(result.fills).toHaveLength(0);
      expect(result.remainingQuantity).toBe(10n);
      expect(orderBook.status(iocBuy.serverOrderId!)).toBeUndefined();
    });
  });

  describe("Rejection — throws", () => {
    it("should throw on invalid tick size (preserving backward compatibility)", () => {
      // Default instrument has tickSize = 0.01 = 1n internal.
      // Use an instrument with tickSize = 5n to get a genuine rejection
      const tickInstrument = createInstrument(
        "TICK2",
        2,
        0,
        toCanonicalDecimal("0.05", 2), // tickSize = 5 internal
        toCanonicalDecimal("0.05", 2),
        toCanonicalDecimal("1000000.00", 2),
      );
      const tickBook = new OrderBook(tickInstrument, noOpLogger, noOpMetrics);

      // 5001n is not a multiple of 5 → tick size rejection
      const order = new Order("bad-tick", Side.BUY, 5001n, 10n);
      expect(() => helperAdd(tickBook, order)).toThrow("tick size");
    });

    it("should throw on quantity exceeding system max", () => {
      // MAX_QUANTITY_VALUE is the system limit
      const order = new Order("huge-qty", Side.BUY, 5000n, 2n ** 63n);
      expect(() => helperAdd(orderBook, order)).toThrow();
    });
  });

  describe("serverOrderId", () => {
    it("should include serverOrderId as string in result", () => {
      const result = helperAdd(orderBook, new Order("id-check", Side.BUY, 5000n, 10n));
      expect(typeof result.serverOrderId).toBe("string");
      expect(result.serverOrderId.length).toBeGreaterThan(0);
    });

    it("should have unique serverOrderIds across orders", () => {
      const r1 = helperAdd(orderBook, new Order("order-1", Side.BUY, 5000n, 10n));
      const r2 = helperAdd(orderBook, new Order("order-2", Side.BUY, 5100n, 10n));
      expect(r1.serverOrderId).not.toBe(r2.serverOrderId);
    });
  });
});
