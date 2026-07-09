// tests/trade.spec.ts

import { describe, expect, it } from "bun:test";
import { parseToInternal, toCanonicalDecimal } from "../src/instrument";
import { Order } from "../src/order";
import { Trade } from "../src/trade";
import { Price, Side } from "../src/types";

// =============================================================================
// TEST HELPER UTILITY
// =============================================================================
const testToInternalPrice = (displayPrice: number | string, precision = 2): Price => {
  return parseToInternal(toCanonicalDecimal(String(displayPrice), precision), precision) as Price;
};

describe("Trade", () => {
  const sellMaker = new Order("maker-sell-1", Side.SELL, testToInternalPrice("200.00"), 100n);
  const buyTaker = new Order("taker-buy-1", Side.BUY, testToInternalPrice("200.50"), 50n);
  const buyMaker = new Order("maker-buy-1", Side.BUY, testToInternalPrice("199.00"), 80n);
  const sellTaker = new Order("taker-sell-1", Side.SELL, testToInternalPrice("198.50"), 30n);

  describe("Initialization", () => {
    it("should be initialized correctly with data from a SELL maker and BUY taker", () => {
      const trade = new Trade(sellMaker, buyTaker, 50n, sellMaker.price, 1001);
      expect(trade.makingOrderId).toBe("maker-sell-1");
      expect(trade.takingOrderId).toBe("taker-buy-1");
      expect(trade.matchQuantity).toBe(50n);
      expect(trade.matchPrice).toBe(20000n);
      expect(trade.tradeId).toBe(1001);
    });
  });

  describe("Cost Calculation", () => {
    it("should calculate the total cost of the trade correctly", () => {
      const trade = new Trade(sellMaker, buyTaker, 10n, 15050n, 1003);
      expect(trade.cost()).toBe(150500n);
    });

    it("should return a cost of zero for a trade with zero quantity", () => {
      const trade = new Trade(sellMaker, buyTaker, 0n, 15050n, 1004);
      expect(trade.cost()).toBe(0n);
    });

    it("should handle large numbers correctly without overflow", () => {
      const highPrice = 5000000n; // $50,000.00
      const highQuantity = 250000000n; // 2.5 BTC (with 8 decimal places)
      const trade = new Trade(sellMaker, buyTaker, highQuantity, highPrice, 1006);
      expect(trade.cost()).toBe(1250000000000000n);
    });
  });

  describe("Object Pooling Support (init method)", () => {
    it("should correctly re-initialize an existing trade object", () => {
      const initialTrade = new Trade(sellMaker, buyTaker, 50n, sellMaker.price, 1001);
      initialTrade.init(buyMaker, sellTaker, 25n, buyMaker.price, 2002);
      expect(initialTrade.tradeId).toBe(2002);
      expect(initialTrade.makingOrderId).toBe("maker-buy-1");
      expect(initialTrade.matchQuantity).toBe(25n);
    });
  });
});
