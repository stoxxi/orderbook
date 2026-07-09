// packages/orderbook/__tests__/newtests.spec.ts

import { beforeEach, describe, expect, it, vi } from "bun:test";
import { helperAdd } from "./_helpers";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { Depth, DepthLevel } from "../src/depth";
import { OrderBookError } from "../src/errors"; // <-- assuming this exists
import {
  createInstrument,
  Instrument,
  parseToInternal,
  toCanonicalDecimal,
} from "../src/instrument";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { getOrderRejectReasonText, OrderRejectReason } from "../src/reasons";
import { Trade } from "../src/trade";
import { tradePool, TradePool } from "../src/tradePool";
import { Price, Quantity, Side } from "../src/types";

// ---------------------------
// Helper utilities
// ---------------------------
const testToInternalPrice = (displayPrice: number | string, precision = 2): Price => {
  return parseToInternal(toCanonicalDecimal(String(displayPrice), precision), precision) as Price;
};

const testToInternalQuantity = (displayQuantity: number | string, precision = 0): Quantity => {
  const qtyStr = String(displayQuantity);
  const parts = qtyStr.split(".");
  const whole = parts[0];
  const fraction = (parts[1] || "").padEnd(precision, "0");
  return BigInt(whole + fraction);
};

// ---------------------------
// Depth tests
// ---------------------------
describe("Depth", () => {
  let depth: Depth;

  beforeEach(() => {
    depth = new Depth();
  });

  describe("Initialization and State", () => {
    it("should be initialized with empty bids and asks arrays", () => {
      expect(depth.bids).toBeInstanceOf(Array);
      expect(depth.asks).toBeInstanceOf(Array);
      expect(depth.bids).toHaveLength(0);
      expect(depth.asks).toHaveLength(0);
      expect(depth.lastChange).toBe(0);
    });

    it("should clear all bid and ask levels correctly", () => {
      depth.addBidLevel({
        price: testToInternalPrice(100),
        quantity: 50n,
        orderCount: 1,
      });
      depth.addAskLevel({
        price: testToInternalPrice(101),
        quantity: 75n,
        orderCount: 2,
      });
      depth.clear();
      expect(depth.bids).toEqual([]);
      expect(depth.asks).toEqual([]);
    });
  });

  describe("Adding Depth Levels", () => {
    it("should add a single bid level correctly", () => {
      const level: DepthLevel = {
        price: testToInternalPrice(100.5),
        quantity: 50n,
        orderCount: 1,
      };
      depth.addBidLevel(level);
      expect(depth.bids).toHaveLength(1);
      expect(depth.bids[0]).toEqual(level);
    });

    it("should add a single ask level correctly", () => {
      const level: DepthLevel = {
        price: testToInternalPrice(101.25),
        quantity: 75n,
        orderCount: 2,
      };
      depth.addAskLevel(level);
      expect(depth.asks).toHaveLength(1);
      expect(depth.asks[0]).toEqual(level);
    });
  });

  describe("Cloning", () => {
    beforeEach(() => {
      depth.addBidLevel({ price: 10000n, quantity: 10n, orderCount: 1 });
      depth.addAskLevel({ price: 10100n, quantity: 20n, orderCount: 2 });
      depth.lastChange = 1234567890;
    });

    it("should create a clone with identical bid, ask levels, and lastChange", () => {
      const clone = depth.shallowClone();
      expect(clone.bids).toEqual(depth.bids);
      expect(clone.asks).toEqual(depth.asks);
      expect(clone.lastChange).toBe(depth.lastChange);
    });

    it("should create a deep copy of the arrays, not a reference", () => {
      const clone = depth.shallowClone();
      expect(clone.bids).not.toBe(depth.bids);
      expect(clone.asks).not.toBe(depth.asks);
    });

    it("should ensure that modifying the clone does not affect the original", () => {
      const clone = depth.shallowClone();
      clone.addBidLevel({ price: 9900n, quantity: 5n, orderCount: 1 });
      clone.clear();
      expect(depth.bids).toHaveLength(1);
      expect(depth.asks).toHaveLength(1);
      expect(depth.bids[0].price).toBe(10000n);
    });

    it("should ensure that modifying the original does not affect a previously created clone", () => {
      const clone = depth.shallowClone();
      depth.addAskLevel({ price: 10200n, quantity: 30n, orderCount: 3 });
      depth.lastChange = Date.now();
      expect(clone.asks).toHaveLength(1);
      expect(clone.asks[0].price).toBe(10100n);
      expect(clone.lastChange).toBe(1234567890);
    });
  });
});

// ---------------------------
// Order tests
// ---------------------------
describe("Order", () => {
  describe("Initialization and Properties", () => {
    it("should be initialized correctly with all properties", () => {
      const price = testToInternalPrice("150.25");
      const quantity = testToInternalQuantity("100");
      const userData = { userId: "user123", strategy: "momentum" };

      const order = new Order("client-order-1", Side.BUY, price, quantity, userData);

      expect(order.orderId).toBe("client-order-1");
      expect(order.side).toBe(Side.BUY);
      expect(order.price).toBe(15025n);
      expect(order.orderQuantity).toBe(100n);
      expect(order.openQuantity).toBe(100n);
      expect(order.serverOrderId).toBeNull();
      expect(order.state).toBe(OrderState.PENDING_NEW);
      expect(order.userData).toEqual(userData);
    });

    it("should throw when order has zero quantity", () => {
      expect(() => new Order("order-zero-qty", Side.BUY, 10000n, 0n)).toThrow(
        /Quantity must be positive/,
      );
    });
  });

  describe("Quantity Management", () => {
    it("should decrease the open quantity correctly on a partial fill", () => {
      const order = new Order("order-partial", Side.SELL, 5000n, 50n);
      order.decreaseQuantity(20n);
      expect(order.openQuantity).toBe(30n);
      expect(order.isFilled()).toBe(false);
    });

    it("should mark the order as filled when open quantity becomes exactly zero", () => {
      const order = new Order("order-full", Side.BUY, 9900n, 75n);
      order.decreaseQuantity(75n);
      expect(order.openQuantity).toBe(0n);
      expect(order.isFilled()).toBe(true);
    });

    it("should clamp open quantity to zero when over-filled", () => {
      const order = new Order("order-overfill", Side.SELL, 1000n, 40n);
      order.decreaseQuantity(50n);
      expect(order.openQuantity).toBe(0n);
      expect(order.isFilled()).toBe(true);
    });

    it("should throw an error when attempting to decrease by a negative number", () => {
      const order = new Order("order-neg-decrease", Side.BUY, 1000n, 40n);
      const action = () => order.decreaseQuantity(-10n);
      expect(action).toThrow("Quantity to decrease cannot be negative.");
      expect(order.openQuantity).toBe(40n);
    });
  });

  describe("Order Type Classification", () => {
    it("should correctly identify a limit order (price > 0)", () => {
      const limitOrder = new Order("limit-1", Side.BUY, 1n, 100n);
      expect(limitOrder.isLimit()).toBe(true);
      expect(limitOrder.isMarket()).toBe(false);
    });

    it("should correctly identify a market order (price === 0)", () => {
      const marketOrder = new Order("market-1", Side.BUY, 0n, 100n);
      expect(marketOrder.isLimit()).toBe(false);
      expect(marketOrder.isMarket()).toBe(true);
    });
  });
});

// ---------------------------
// Trade tests
// ---------------------------
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
      const highQuantity = 250000000n; // large quantity
      const trade = new Trade(sellMaker, buyTaker, highQuantity, highPrice, 1006);
      expect(trade.cost()).toBe(highPrice * highQuantity);
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

// ---------------------------
// TradePool tests
// ---------------------------
describe("TradePool", () => {
  const maker = new Order("maker", Side.BUY, 100n, 10n);
  const taker = new Order("taker", Side.SELL, 100n, 10n);

  const getPool = (): Trade[] => (tradePool as unknown as { pool: Trade[] }).pool;

  beforeEach(() => {
    getPool().length = 0;
  });

  it("should create a new Trade object when the pool is empty", () => {
    const trade = tradePool.get(maker, taker, 10n, 100n, 1);
    expect(trade).toBeInstanceOf(Trade);
    expect(trade.tradeId).toBe(1);
  });

  it("should reuse a Trade object from the pool on the second get", () => {
    const trade1 = tradePool.get(maker, taker, 10n, 100n, 1);
    tradePool.release(trade1);
    const trade2 = tradePool.get(maker, taker, 5n, 101n, 2);
    expect(trade2).toBe(trade1);
    expect(trade2.tradeId).toBe(2);
  });

  it("should not exceed maximum pool size", () => {
    // Create a local pool so we don't have to fill 10,000 items to test overflow
    const localPool = new TradePool(2);

    // 1. Get 3 objects to empty the pool and have them in hand
    const trade1 = localPool.get(maker, taker, 1n, 1n, 1);
    const trade2 = localPool.get(maker, taker, 2n, 2n, 2);
    const trade3 = localPool.get(maker, taker, 3n, 3n, 3);

    // 2. Release them all. Since capacity is 2, the 3rd should be dropped.
    localPool.release(trade1);
    localPool.release(trade2);
    localPool.release(trade3); // This one should be dropped (GC'd)

    // 3. Access capacity property directly from the instance
    const capacity = (localPool as any).capacity;
    expect((localPool as any).pool.length).toBe(capacity);

    //    const maxSize = (tradePool as unknown as { MAX_POOL_SIZE: number }).MAX_POOL_SIZE;
    //    expect(getPool().length).toBeLessThanOrEqual(maxSize);
  });
});

// ---------------------------
// OrderBook tests
// ---------------------------
describe("OrderBook", () => {
  let orderBook: OrderBook;
  let instrument: Instrument;

  beforeEach(() => {
    vi.clearAllMocks();
    instrument = createInstrument(
      "TEST",
      2,
      0,
      toCanonicalDecimal("0.01", 2), // tickSize
      toCanonicalDecimal("0.01", 2), // minPrice
      toCanonicalDecimal("1000000.00", 2), // maxPrice
    );
    orderBook = new OrderBook<Order>(instrument, noOpLogger, noOpMetrics);
  });

  describe("Order Submission (add)", () => {
    it("should accept a valid limit order", () => {
      const order = new Order("1", Side.BUY, 10000n, 10n);
      helperAdd(orderBook, order);
      expect(order.state).toBe(OrderState.NEW);
    });

    it("should throw when order has zero quantity", () => {
      expect(() => new Order("2", Side.BUY, 10000n, 0n)).toThrowError(/Quantity must be positive/);
    });

    it("should accept a market order (with zero price)", () => {
      const order = new Order("3", Side.BUY, 0n, 10n);
      helperAdd(orderBook, order);
      // In v3.5, unmatched market orders are CANCELED (IOC)
      expect(order.state).toBe(OrderState.CANCELED);
      expect(order.isMarket()).toBe(true);
    });

    it("should throw when price violates tick size", () => {
      const nickelBook = OrderBook.create("NICKEL", { tickSize: "5" });
      const order = new Order("4", Side.BUY, 10007n, 10n);
      expect(() => helperAdd(nickelBook, order)).toThrowError(/multiple of the tick size/);
    });
  });

  describe("Order Cancellation (cancel)", () => {
    it("should throw when canceling unknown order", () => {
      expect(() => orderBook.cancel(999n)).toThrowError(/SID 999 not found/);
    });

    it("should throw when canceling a filled order", () => {
      const buyOrder = new Order("buy", Side.BUY, 10000n, 10n);
      const sellOrder = new Order("sell", Side.SELL, 10000n, 10n);
      helperAdd(orderBook, buyOrder);
      helperAdd(orderBook, sellOrder);
      expect(() => orderBook.cancel(buyOrder.serverOrderId!)).toThrowError(/SID \d+ not found/);
    });
  });

  describe("Order Modification (replace)", () => {
    it("should return UnknownOrder when replacing a filled order", () => {
      const buyOrder = new Order("buy-replace-fill", Side.BUY, 10000n, 10n);
      const sellOrder = new Order("sell-fill", Side.SELL, 10000n, 10n); // Fully fills buy
      helperAdd(orderBook, buyOrder);
      helperAdd(orderBook, sellOrder);
      // Filled orders are removed from orderMap
      expect(buyOrder.state).toBe(OrderState.FILLED);
      expect(() => orderBook.replace(buyOrder.serverOrderId!, 5n, 10000n)).toThrowError(
        /SID \d+ not found/,
      );
    });

    it("should throw when replace request has no changes", () => {
      const order = new Order("replace-no-change", Side.BUY, 10000n, 10n);
      helperAdd(orderBook, order);
      expect(() => orderBook.replace(order.serverOrderId!, 10n, 10000n)).toThrowError(
        /No changes made/,
      );
    });
  });

  describe("State and Status", () => {
    it("should throw when cancel/replace requested in pending states", () => {
      const order = new Order("pending", Side.BUY, 10000n, 10n);
      helperAdd(orderBook, order);

      order.state = OrderState.PENDING_REPLACE;
      expect(() => orderBook.cancel(order.serverOrderId!)).toThrowError(
        /Cannot cancel order in state 'PENDING_REPLACE'/,
      );

      order.state = OrderState.PENDING_CANCEL;
      expect(() => orderBook.replace(order.serverOrderId!, 15n, 10000n)).toThrowError(
        /Cannot replace order in state 'PENDING_CANCEL'/,
      );
    });
  });
});

// ---------------------------
// OrderBookError tests
// ---------------------------
describe("OrderBookError", () => {
  it.each([
    [OrderRejectReason.QtyMustBePositive, "Quantity must be > 0"],
    [OrderRejectReason.InvalidTickSize, "Price must be a multiple of the tick size"],
    [OrderRejectReason.Other, "Something went wrong"],
  ])("should correctly expose code=%s and message='%s'", (code, message) => {
    const error = new OrderBookError(code, message);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code); // ✅ .code instead of .reason
    expect(error.message).toBe(message);
    expect(error.name).toBe("OrderBookError");
  });

  it("should stringify with code and message", () => {
    const error = new OrderBookError(OrderRejectReason.ConsistencyError, "Invalid state");
    const asString = String(error);

    expect(asString).toContain("OrderBookError");
    expect(asString).toContain("Invalid state");
    expect(asString).toContain(OrderRejectReason.ConsistencyError.toString());
  });
});

// ---------------------------
// getOrderRejectReasonText tests
// ---------------------------
describe("getOrderRejectReasonText", () => {
  it("should return the correct description for each known reason", () => {
    expect(getOrderRejectReasonText(OrderRejectReason.UnknownSymbol)).toBe("Unknown symbol");
    expect(getOrderRejectReasonText(OrderRejectReason.MarketClosed)).toBe("market closed");
    expect(getOrderRejectReasonText(OrderRejectReason.UnknownOrder)).toBe("Unknown order");
    expect(getOrderRejectReasonText(OrderRejectReason.DuplicateOrder)).toBe("Duplicate order");
    expect(getOrderRejectReasonText(OrderRejectReason.IncorrectQuantity)).toBe(
      "Incorrect quantity",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.InvalidInvestorID)).toBe("Unknown User");
    expect(getOrderRejectReasonText(OrderRejectReason.OrderAlreadyFilled)).toBe(
      "Cannot modify a fully filled order",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.QtyLessThanFilled)).toBe(
      "Quantity cannot be less than filled quantity",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.QtyMustBePositive)).toBe(
      "Quantity must be positive; use cancel() to remove order",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.NoChange)).toBe(
      "No changes made in replace request",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.ConsistencyError)).toBe(
      "Order consistency error",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.UserContextRequired)).toBe(
      "User context is missing from the order",
    );
    expect(getOrderRejectReasonText(OrderRejectReason.Other)).toBe("Other or unknown reason");
  });

  it("should return 'Other or unknown reason' for an unmapped code", () => {
    expect(getOrderRejectReasonText(99999 as OrderRejectReason)).toBe("Other or unknown reason");
  });
});
