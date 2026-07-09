// packages/orderbook/__tests__/orderbook-grok.spec.ts

import { beforeEach, describe, expect, it, vi } from "bun:test";
import { helperAdd } from "./_helpers";

import { noOpLogger } from "../src/logging";

import { Depth, DepthLevel } from "../src/depth";
import { OrderBookError } from "../src/errors";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { Limit } from "../src/limit";
import { BboListener, DepthListener, OrderListener, TradeListener } from "../src/listeners";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { OrderRejectReason } from "../src/reasons";
import { Trade, TradeSnapshot } from "../src/trade";
import { TradePool, tradePool } from "../src/tradePool";
import { Price, Quantity, Side } from "../src/types";

// Helper types for iterator
type IteratorType<K extends bigint> = {
  value: Limit<Order> | undefined;
  key: K;
  next: () => void;
  equals: (other: IteratorReturnType) => boolean | undefined;
};
type IteratorReturnType = { equals: () => boolean };

// Helper functions for test data
const createTestOrder = (id: string, side: Side, price: Price, qty: Quantity) =>
  new Order(id, side, price, qty);
//const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), fatal: vi.fn() };
const mockMetrics = {
  ordersProcessed: { add: vi.fn(), inc: vi.fn() },
  tradesExecuted: { add: vi.fn(), inc: vi.fn() },
  orderBookLatency: { record: vi.fn() },
  exchangeLatency: { record: vi.fn() },
  orderBookDepth: { set: vi.fn() },
  walBackpressure: { add: vi.fn(), inc: vi.fn() },
  walBackpressureDelay: { record: vi.fn() },
  systemEvents: { add: vi.fn(), inc: vi.fn() },
  settlementQueueSize: { set: vi.fn() },
  memoryUsage: { set: vi.fn() },
  updateLogMetrics: vi.fn(),
};

describe("OrderBook Implementation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset tradePool singleton for each test
    (
      tradePool as unknown as {
        pool: Trade[];
        hitCount: number;
        missCount: number;
      }
    ).pool = [];
    (
      tradePool as unknown as {
        pool: Trade[];
        hitCount: number;
        missCount: number;
      }
    ).hitCount = 0;
    (
      tradePool as unknown as {
        pool: Trade[];
        hitCount: number;
        missCount: number;
      }
    ).missCount = 0;
  });

  describe("Depth", () => {
    let depth: Depth;

    beforeEach(() => {
      depth = new Depth();
    });

    describe("Initialization", () => {
      it("should initialize with empty bids and asks and lastChange 0", () => {
        expect(depth.bids).toEqual([]);
        expect(depth.asks).toEqual([]);
        expect(depth.lastChange).toBe(0);
      });
    });

    describe("clear", () => {
      it("should clear all levels", () => {
        depth.addBidLevel({ price: 100n, quantity: 10n, orderCount: 1 });
        depth.addAskLevel({ price: 110n, quantity: 20n, orderCount: 2 });
        depth.clear();
        expect(depth.bids).toEqual([]);
        expect(depth.asks).toEqual([]);
      });
    });

    describe("clone", () => {
      it("should create a deep clone", () => {
        depth.addBidLevel({ price: 100n, quantity: 10n, orderCount: 1 });
        depth.addAskLevel({ price: 110n, quantity: 20n, orderCount: 2 });
        depth.lastChange = 123;
        const clone = depth.shallowClone();
        expect(clone.bids).toEqual(depth.bids);
        expect(clone.asks).toEqual(depth.asks);
        expect(clone.lastChange).toBe(123);
        expect(clone.bids).not.toBe(depth.bids); // Deep copy
        clone.addBidLevel({ price: 90n, quantity: 5n, orderCount: 1 });
        expect(depth.bids.length).toBe(1);
      });

      it("should clone empty depth correctly", () => {
        const clone = depth.shallowClone();
        expect(clone.bids).toEqual([]);
        expect(clone.asks).toEqual([]);
        expect(clone.lastChange).toBe(0);
      });
    });

    describe("addBidLevel", () => {
      it("should add bid level", () => {
        const level: DepthLevel = { price: 100n, quantity: 10n, orderCount: 1 };
        depth.addBidLevel(level);
        expect(depth.bids).toEqual([level]);
      });
    });

    describe("addAskLevel", () => {
      it("should add ask level", () => {
        const level: DepthLevel = { price: 110n, quantity: 20n, orderCount: 2 };
        depth.addAskLevel(level);
        expect(depth.asks).toEqual([level]);
      });
    });
  });

  describe("OrderBookError", () => {
    it("should create error with code and message", () => {
      const err = new OrderBookError(OrderRejectReason.UnknownOrder, "Test message");
      expect(err.code).toBe(OrderRejectReason.UnknownOrder);
      expect(err.message).toBe("Test message");
      expect(err.name).toBe("OrderBookError");
    });

    it("should inherit from Error", () => {
      const err = new OrderBookError(OrderRejectReason.Other, "Other");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("Instrument", () => {
    describe("createInstrument", () => {
      it("should create with custom options", () => {
        const inst = createInstrument(
          "BTC",
          8,
          8,
          toCanonicalDecimal("0.00000100", 8), // tickSize (100n internal)
          toCanonicalDecimal("0.00000100", 8), // minPrice
          toCanonicalDecimal("999999.99999900", 8), // maxPrice
        );
        expect(inst.pricePrecision).toBe(8);
        expect(inst.tickSize).toBe(100n);
      });
    });
  });

  describe("Limit", () => {
    let limit: Limit<Order>;

    beforeEach(() => {
      limit = new Limit(100n);
    });

    describe("constructor", () => {
      it("should initialize correctly", () => {
        expect(limit.price).toBe(100n);
        expect(limit.totalQuantity).toBe(0n);
        expect(limit.orderCount).toBe(0);
        expect(limit.isEmpty()).toBe(true);
      });

      it("should throw on negative price", () => {
        expect(() => new Limit(-1n)).toThrow(
          "Invariant violation: Limit price must be a non-negative bigint",
        );
      });

      it("should throw on null price", () => {
        expect(() => new Limit(null as unknown as bigint)).toThrow(
          "Invariant violation: Limit price must be a non-negative bigint",
        );
      });
    });

    describe("addOrder", () => {
      it("should add order and update quantity", () => {
        const order = createTestOrder("1", Side.BUY, 100n, 10n);
        order.serverOrderId = 1n; // Required for intrusive linked list
        limit.addOrder(order);
        expect(limit.orderCount).toBe(1);
        expect(limit.totalQuantity).toBe(10n);
        expect(limit.isEmpty()).toBe(false);
      });
    });

    describe("removeOrder", () => {
      it("should remove order and update quantity", () => {
        const order1 = createTestOrder("1", Side.BUY, 100n, 10n);
        const order2 = createTestOrder("2", Side.BUY, 100n, 20n);
        order1.serverOrderId = 1n; // Required for intrusive linked list
        order2.serverOrderId = 2n;
        limit.addOrder(order1);
        limit.addOrder(order2);
        const removed = limit.removeOrder(order1);
        expect(removed).toBe(true);
        expect(limit.orderCount).toBe(1);
        expect(limit.totalQuantity).toBe(20n);
      });

      it("should return false if order not found", () => {
        const order = createTestOrder("1", Side.BUY, 100n, 10n);
        order.serverOrderId = 1n;
        expect(limit.removeOrder(order)).toBe(false);
      });
    });

    describe("updateQuantity", () => {
      it("should update total quantity", () => {
        limit.updateQuantity(10n);
        expect(limit.totalQuantity).toBe(10n);
        limit.updateQuantity(-5n);
        expect(limit.totalQuantity).toBe(5n);
      });
    });

    describe("peekFront", () => {
      it("should return front order", () => {
        const order1 = createTestOrder("1", Side.BUY, 100n, 10n);
        const order2 = createTestOrder("2", Side.BUY, 100n, 20n);
        order1.serverOrderId = 1n; // Required for intrusive linked list
        order2.serverOrderId = 2n;
        limit.addOrder(order1);
        limit.addOrder(order2);
        expect(limit.peekFront()).toBe(order1);
      });

      it("should return undefined on empty", () => {
        expect(limit.peekFront()).toBeUndefined();
      });
    });

    describe("popFront", () => {
      it("should pop front and update quantity", () => {
        const order1 = createTestOrder("1", Side.BUY, 100n, 10n);
        const order2 = createTestOrder("2", Side.BUY, 100n, 20n);
        order1.serverOrderId = 1n; // Required for intrusive linked list
        order2.serverOrderId = 2n;
        limit.addOrder(order1);
        limit.addOrder(order2);
        expect(limit.totalQuantity).toBe(30n);
        const popped = limit.popFront();
        expect(popped).toBe(order1);
        expect(limit.totalQuantity).toBe(20n);
        expect(limit.orderCount).toBe(1);
      });

      it("should return undefined on empty", () => {
        expect(limit.popFront()).toBeUndefined();
      });

      it("should handle pop when openQuantity is 0", () => {
        const order = createTestOrder("1", Side.BUY, 100n, 10n);
        order.serverOrderId = 1n; // Required for intrusive linked list
        limit.addOrder(order);
        // Properly simulate fill: decrease order qty and update limit total
        order.decreaseQuantity(10n);
        limit.updateQuantity(-10n);
        expect(order.openQuantity).toBe(0n);
        limit.popFront();
        expect(limit.totalQuantity).toBe(0n);
      });
    });
  });

  describe("Order", () => {
    describe("constructor", () => {
      it("should initialize correctly", () => {
        const order = new Order("1", Side.BUY, 100n, 10n, { custom: "data" });
        expect(order.orderId).toBe("1");
        expect(order.side).toBe(Side.BUY);
        expect(order.price).toBe(100n);
        expect(order.orderQuantity).toBe(10n);
        expect(order.openQuantity).toBe(10n);
        expect(order.serverOrderId).toBeNull();
        expect(order.state).toBe(OrderState.PENDING_NEW);
        expect(order.userData).toEqual({ custom: "data" });
      });

      it("should default userData to null", () => {
        const order = new Order("1", Side.BUY, 100n, 10n);
        expect(order.userData).toBeNull();
      });

      it("should throw on empty orderId", () => {
        expect(() => new Order("", Side.BUY, 100n, 10n)).toThrow(
          "Order ID cannot be null or empty",
        );
      });

      it("should throw on invalid side", () => {
        expect(() => new Order("1", 999 as Side, 100n, 10n)).toThrow("Invalid side");
      });

      it("should throw on negative price", () => {
        expect(() => new Order("1", Side.BUY, -1n, 10n)).toThrow("Price cannot be negative");
      });

      it("should throw on negative quantity", () => {
        expect(() => new Order("1", Side.BUY, 100n, -1n)).toThrow(/Quantity must be positive/);
      });
    });

    describe("decreaseQuantity", () => {
      let order: Order;

      beforeEach(() => {
        order = new Order("1", Side.BUY, 100n, 50n);
      });

      it("should decrease openQuantity", () => {
        order.decreaseQuantity(20n);
        expect(order.openQuantity).toBe(30n);
      });

      it("should clamp to 0 on over-decrease", () => {
        order.decreaseQuantity(60n);
        expect(order.openQuantity).toBe(0n);
      });

      it("should throw on negative decrease", () => {
        expect(() => order.decreaseQuantity(-10n)).toThrow(
          "Quantity to decrease cannot be negative",
        );
      });
    });

    describe("isFilled", () => {
      it("should return true when openQuantity is 0", () => {
        const order = new Order("1", Side.BUY, 100n, 10n);
        order.decreaseQuantity(10n);
        expect(order.isFilled()).toBe(true);
      });

      it("should return false when openQuantity > 0", () => {
        const order = new Order("1", Side.BUY, 100n, 10n);
        expect(order.isFilled()).toBe(false);
      });
    });

    describe("isLimit", () => {
      it("should return true for price > 0", () => {
        const order = new Order("1", Side.BUY, 1n, 10n);
        expect(order.isLimit()).toBe(true);
      });

      it("should return false for price = 0", () => {
        const order = new Order("1", Side.BUY, 0n, 10n);
        expect(order.isLimit()).toBe(false);
      });
    });

    describe("isMarket", () => {
      it("should return true for price = 0", () => {
        const order = new Order("1", Side.BUY, 0n, 10n);
        expect(order.isMarket()).toBe(true);
      });

      it("should return false for price > 0", () => {
        const order = new Order("1", Side.BUY, 1n, 10n);
        expect(order.isMarket()).toBe(false);
      });
    });
  });

  describe("Trade", () => {
    let maker: Order;
    let taker: Order;

    beforeEach(() => {
      maker = new Order("maker", Side.SELL, 20000n, 100n);
      taker = new Order("taker", Side.BUY, 20050n, 50n);
    });

    describe("init", () => {
      it("should initialize properties", () => {
        const trade = new Trade(maker, taker, 50n, 20000n, 1);
        expect(trade.makingOrderId).toBe("maker");
        expect(trade.takingOrderId).toBe("taker");
        expect(trade.matchQuantity).toBe(50n);
        expect(trade.matchPrice).toBe(20000n);
        expect(trade.tradeId).toBe(1);
      });

      it("should re-initialize", () => {
        const trade = new Trade(maker, taker, 50n, 20000n, 1);
        const newMaker = new Order("newMaker", Side.BUY, 19900n, 80n);
        const newTaker = new Order("newTaker", Side.SELL, 19850n, 30n);
        trade.init(newMaker, newTaker, 25n, 19900n, 2);
        expect(trade.makingOrderId).toBe("newMaker");
        expect(trade.takingOrderId).toBe("newTaker");
        expect(trade.matchQuantity).toBe(25n);
        expect(trade.matchPrice).toBe(19900n);
        expect(trade.tradeId).toBe(2);
      });
    });

    describe("cost", () => {
      it("should calculate cost", () => {
        const trade = new Trade(maker, taker, 10n, 15050n, 1);
        expect(trade.cost()).toBe(150500n);
      });

      it("should return 0 for zero quantity", () => {
        const trade = new Trade(maker, taker, 0n, 15050n, 1);
        expect(trade.cost()).toBe(0n);
      });

      it("should handle large numbers", () => {
        const trade = new Trade(maker, taker, 250000000n, 5000000n, 1);
        expect(trade.cost()).toBe(1250000000000000n);
      });
    });

    describe("snapshot", () => {
      it("should return immutable snapshot", () => {
        const trade = new Trade(maker, taker, 50n, 20000n, 1);
        const snap: TradeSnapshot = trade.snapshot();
        expect(snap).toEqual({
          makingOrderId: "maker",
          takingOrderId: "taker",
          matchQuantity: 50n,
          matchPrice: 20000n,
          tradeId: 1,
        });
        // Verify immutability
        const mutableSnap = snap as { matchQuantity: bigint };
        mutableSnap.matchQuantity = 100n;
        expect(trade.matchQuantity).toBe(50n);
      });
    });
  });

  describe("TradePool", () => {
    let pool: TradePool;
    let maker: Order;
    let taker: Order;

    beforeEach(() => {
      pool = new TradePool(2); // Small capacity for testing
      maker = new Order("maker", Side.BUY, 100n, 10n);
      taker = new Order("taker", Side.SELL, 100n, 10n);
    });

    describe("get", () => {
      it("should create new when empty", () => {
        const trade = pool.get(maker, taker, 10n, 100n, 1);
        expect(trade.tradeId).toBe(1);
        expect((pool as unknown as { missCount: number }).missCount).toBe(1);
      });

      it("should reuse from pool", () => {
        const trade1 = pool.get(maker, taker, 10n, 100n, 1);
        pool.release(trade1);
        const trade2 = pool.get(maker, taker, 20n, 200n, 2);
        expect(trade2).toBe(trade1);
        expect(trade2.matchQuantity).toBe(20n);
        expect((pool as unknown as { hitCount: number }).hitCount).toBe(1);
      });
    });

    describe("release", () => {
      it("should add back to pool and sanitize", () => {
        const trade = pool.get(maker, taker, 10n, 100n, 1);
        pool.release(trade);
        expect((pool as unknown as { pool: Trade[] }).pool.length).toBe(1);
        expect(trade.makingOrderId).toBe("");
        expect(trade.takingOrderId).toBe("");
        expect(trade.matchQuantity).toBe(0n);
        expect(trade.matchPrice).toBe(0n);
        expect(trade.tradeId).toBe(0);
      });

      it("should not add if over capacity", () => {
        // Get 3 trades (all misses since pool is empty)
        const trade1 = pool.get(maker, taker, 1n, 1n, 1);
        const trade2 = pool.get(maker, taker, 2n, 2n, 2);
        const trade3 = pool.get(maker, taker, 3n, 3n, 3);
        // Release all 3 - but pool capacity is 2, so only 2 should be kept
        pool.release(trade1);
        pool.release(trade2);
        pool.release(trade3);
        expect((pool as unknown as { pool: Trade[] }).pool.length).toBe(2);
      });
    });

    describe("getPoolStats", () => {
      it("should return stats", () => {
        pool.get(maker, taker, 10n, 100n, 1); // miss
        const trade = pool.get(maker, taker, 20n, 200n, 2); // miss
        pool.release(trade);
        pool.get(maker, taker, 30n, 300n, 3); // hit
        const stats = pool.getPoolStats();
        expect(stats.size).toBe(0); // After hit, pool empty again
        expect(stats.capacity).toBe(2);
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(2);
        expect(stats.hitRate).toBe(1 / 3);
      });

      it("should handle zero gets", () => {
        const stats = pool.getPoolStats();
        expect(stats.hitRate).toBe(0);
      });
    });
  });

  describe("OrderBook", () => {
    // The correct type uses the default generic parameter `TUserData = unknown`.
    let book: OrderBook;
    let instrument: Instrument;
    let orderListener: OrderListener<Order>;
    let tradeListener: TradeListener<Order>;
    let bboListener: BboListener<Order>;
    let depthListener: DepthListener<Order>;

    beforeEach(() => {
      instrument = createInstrument(
        "TEST",
        2,
        0,
        toCanonicalDecimal("1", 2), // tickSize
        toCanonicalDecimal("1", 2), // minPrice
        toCanonicalDecimal("1000000", 2), // maxPrice
      );
      book = new OrderBook<Order>(instrument, noOpLogger, mockMetrics);

      orderListener = {
        onAccept: vi.fn(),
        onReject: vi.fn(),
        onFill: vi.fn(),
        onCancel: vi.fn(),
        onCancelReject: vi.fn(),
        onReplace: vi.fn(),
        onReplaceReject: vi.fn(),
      };
      tradeListener = { onTrade: vi.fn() };
      bboListener = { onBboChange: vi.fn() };
      depthListener = { onDepthChange: vi.fn() };
      book.setOrderListener(orderListener);
      book.setTradeListener(tradeListener);
      book.setBboListener(bboListener);
      book.setDepthListener(depthListener);
      vi.spyOn(performance, "now").mockReturnValue(1000);
      vi.spyOn(Date, "now").mockReturnValue(123456);
    });

    describe("create", () => {
      it("should create with defaults", () => {
        const b = OrderBook.create<Order>("TEST");
        const inst = b.getInstrument();

        expect(inst.symbol).toBe("TEST");
        expect(inst.pricePrecision).toBe(2); // Default
        expect(inst.minPrice).toBe(inst.tickSize); // Citadel Invariant
      });

      it("should create with options", () => {
        const b = OrderBook.create<Order>("TEST", {
          pricePrecision: 4,
          tickSize: "5",
        });
        expect(b.getInstrument().pricePrecision).toBe(4);
        expect(b.getInstrument().tickSize).toBe(50000n);
      });
    });

    describe("getters", () => {
      it("should return instrument and symbol", () => {
        expect(book.getInstrument()).toBe(instrument);
        expect(book.getSymbol()).toBe("TEST");
      });
    });

    describe("status", () => {
      it("should return order state", () => {
        const order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);
        expect(book.status(order.serverOrderId!)).toBe(OrderState.NEW);
      });

      it("should return undefined if not found", () => {
        expect(book.status(999n)).toBeUndefined();
      });
    });

    describe("add", () => {
      it("should add valid limit order", () => {
        const order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);

        // Assert that the listener received a snapshot with the correct data.
        expect(orderListener.onAccept).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "1",
            state: OrderState.NEW,
            serverOrderId: 1n,
          }),
        );

        // Check the internal state via a public method.
        expect(book.status(1n)).toBe(OrderState.NEW);
      });

      it("should treat zero price as market order", () => {
        // Zero price = market order, not an invalid limit order
        const order = createTestOrder("1", Side.BUY, 0n, 10n);
        expect(order.isMarket()).toBe(true);
        helperAdd(book, order);
        // Unmatched market order is canceled (IOC behavior)
        expect(order.state).toBe(OrderState.CANCELED);
      });

      it("should reject invalid tick size", () => {
        // FIX: Removed the incorrect <Order> generic.
        const b = OrderBook.create("TEST", { tickSize: "5" });
        b.setOrderListener(orderListener);
        const order = createTestOrder("1", Side.BUY, 10007n, 10n);

        expect(() => b.add(order)).toThrow(OrderBookError);

        expect(orderListener.onReject).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: "1" }), // Check the important properties
          OrderRejectReason.InvalidTickSize,
          expect.stringContaining("tick size"),
        );
      });

      it("should match crossing orders", () => {
        const buy = createTestOrder("buy", Side.BUY, 10000n, 10n);
        const sell = createTestOrder("sell", Side.SELL, 10000n, 10n);
        helperAdd(book, buy);
        helperAdd(book, sell);
        expect(buy.state).toBe(OrderState.FILLED);
        expect(sell.state).toBe(OrderState.FILLED);
        expect(tradeListener.onTrade).toHaveBeenCalledTimes(1);
        expect(orderListener.onFill).toHaveBeenCalledTimes(2);
        expect(mockMetrics.tradesExecuted.add).toHaveBeenCalledTimes(1);
      });

      it("should handle partial fill", () => {
        const buy = createTestOrder("buy", Side.BUY, 10000n, 15n);
        const sell = createTestOrder("sell", Side.SELL, 10000n, 10n);
        helperAdd(book, buy);
        helperAdd(book, sell);
        expect(buy.state).toBe(OrderState.PARTIALLY_FILLED);
        expect(buy.openQuantity).toBe(5n);
        expect(sell.state).toBe(OrderState.FILLED);
      });

      it("should match market order", () => {
        const sellLimit = createTestOrder("sell", Side.SELL, 10000n, 10n);
        const marketBuy = createTestOrder("buy", Side.BUY, 0n, 10n);
        helperAdd(book, sellLimit);
        helperAdd(book, marketBuy);
        expect(sellLimit.state).toBe(OrderState.FILLED);
        expect(marketBuy.state).toBe(OrderState.FILLED);
        expect(tradeListener.onTrade).toHaveBeenCalledTimes(1);
      });

      it("should cancel unmatched market order", () => {
        const market = createTestOrder("buy", Side.BUY, 0n, 10n);
        helperAdd(book, market);
        expect(market.state).toBe(OrderState.CANCELED);
        // Listener receives snapshot, not the Order instance
        expect(orderListener.onCancel).toHaveBeenCalledWith(market.snapshot());
      });

      it("should update BBO on add", () => {
        const order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);
        expect(bboListener.onBboChange).toHaveBeenCalled();
        // Depth uses pull-based updates via getDepth(), not push-based listener
        const depth = book.getDepth();
        expect(depth.bids.length).toBe(1);
        expect(depth.bids[0]?.price).toBe(10000n);
      });
    });

    describe("cancel", () => {
      it("should cancel active order", () => {
        const order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);
        book.cancel(order.serverOrderId!);
        expect(order.state).toBe(OrderState.CANCELED);
        // Listener receives snapshot, not the Order instance
        expect(orderListener.onCancel).toHaveBeenCalledWith(order.snapshot());
      });

      it("should reject unknown order", () => {
        expect(() => book.cancel(999n)).toThrow(OrderBookError);
        expect(orderListener.onCancelReject).toHaveBeenCalledWith(
          null,
          OrderRejectReason.UnknownOrder,
          "SID 999 not found.",
        );
      });

      it("should reject filled order", () => {
        const buy = createTestOrder("buy", Side.BUY, 10000n, 10n);
        const sell = createTestOrder("sell", Side.SELL, 10000n, 10n);
        helperAdd(book, buy);
        helperAdd(book, sell);
        // Filled orders are removed from orderMap, so cancel returns UnknownOrder
        expect(() => book.cancel(buy.serverOrderId!)).toThrow(OrderBookError);
        expect(orderListener.onCancelReject).toHaveBeenCalledWith(
          null,
          OrderRejectReason.UnknownOrder,
          expect.stringContaining("not found"),
        );
      });

      it("should reject in pending states", () => {
        const order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);
        order.state = OrderState.PENDING_REPLACE;
        expect(() => book.cancel(order.serverOrderId!)).toThrow(OrderBookError);
        // Listener receives snapshot, not the Order instance
        expect(orderListener.onCancelReject).toHaveBeenCalledWith(
          order.snapshot(),
          OrderRejectReason.Other,
          expect.stringContaining("PENDING_REPLACE"),
        );
      });
    });

    describe("replace", () => {
      let order: Order;

      beforeEach(() => {
        order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);
      });

      it("should replace with price change (lose priority)", () => {
        book.replace(order.serverOrderId!, 15n, 10100n);
        expect(order.orderQuantity).toBe(15n);
        expect(order.openQuantity).toBe(15n);
        expect(order.price).toBe(10100n);
        expect(order.state).toBe(OrderState.NEW);
        // Listener receives snapshot, not the Order instance
        expect(orderListener.onReplace).toHaveBeenCalledWith(
          order.snapshot(),
          10n, // oldQty
          10000n, // oldPrice
          15n, // newQty
          10100n, // newPrice
        );
      });

      it("should replace with qty decrease (retain priority)", () => {
        book.replace(order.serverOrderId!, 5n, 10000n);
        expect(order.orderQuantity).toBe(5n);
        expect(order.openQuantity).toBe(5n);
        expect(order.state).toBe(OrderState.NEW);
      });

      it("should transition to FILLED on qty decrease to filled", () => {
        const sell = createTestOrder("sell", Side.SELL, 10000n, 5n);
        helperAdd(book, sell);
        expect(order.state).toBe(OrderState.PARTIALLY_FILLED);
        book.replace(order.serverOrderId!, 5n, 10000n);
        expect(order.state).toBe(OrderState.FILLED);
      });

      it("should reject no change", () => {
        expect(() => book.replace(order.serverOrderId!, 10n, 10000n)).toThrow(OrderBookError);
        // Listener receives snapshot, not the Order instance
        expect(orderListener.onReplaceReject).toHaveBeenCalledWith(
          order.snapshot(),
          OrderRejectReason.NoChange,
          expect.any(String),
        );
      });

      it("should reject unknown order", () => {
        expect(() => book.replace(999n, 10n, 10000n)).toThrow(OrderBookError);
        expect(orderListener.onReplaceReject).toHaveBeenCalledWith(
          null,
          OrderRejectReason.UnknownOrder,
          expect.any(String),
        );
      });

      it("should reject in invalid states", () => {
        order.state = OrderState.FILLED;
        expect(() => book.replace(order.serverOrderId!, 15n, 10000n)).toThrow(OrderBookError);
        // Listener receives snapshot, not the Order instance
        expect(orderListener.onReplaceReject).toHaveBeenCalledWith(
          order.snapshot(),
          OrderRejectReason.OrderAlreadyFilled,
          expect.any(String),
        );
      });

      it("should match after replace if aggressive", () => {
        const sell = createTestOrder("sell", Side.SELL, 10200n, 10n);
        helperAdd(book, sell);
        book.replace(order.serverOrderId!, 10n, 10200n);
        expect(order.state).toBe(OrderState.FILLED);
        expect(sell.state).toBe(OrderState.FILLED);
        expect(tradeListener.onTrade).toHaveBeenCalledTimes(1);
      });
    });

    describe("getOrder", () => {
      it("should return order", () => {
        const order = createTestOrder("1", Side.BUY, 10000n, 10n);
        helperAdd(book, order);
        expect(book.getOrder(order.serverOrderId!)).toBe(order);
      });

      it("should return undefined if not found", () => {
        expect(book.getOrder(999n)).toBeUndefined();
      });
    });

    describe("toInternalPrice / fromInternalPrice", () => {
      it("should convert price correctly", () => {
        expect(book.toInternalPrice(100.5)).toBe(10050n);
        expect(book.fromInternalPrice(10050n)).toBe("100.50");
      });

      it("should handle integer price", () => {
        expect(book.toInternalPrice(100)).toBe(10000n);
        expect(book.fromInternalPrice(10000n)).toBe("100.00");
      });

      it("should throw on invalid format", () => {
        expect(() => book.toInternalPrice("abc" as unknown as number)).toThrow(/Invalid format/);
        expect(() => book.toInternalPrice(-100)).toThrow(/Invalid format/);
      });

      it("should throw on excess precision", () => {
        expect(() => book.toInternalPrice(100.123)).toThrow("more precision");
      });
    });

    describe("toInternalQuantity / fromInternalQuantity", () => {
      const b = OrderBook.create<Order>("TEST", { quantityPrecision: 2 });

      it("should convert quantity correctly", () => {
        expect(b.toInternalQuantity(10.5)).toBe(1050n);
        expect(b.fromInternalQuantity(1050n)).toBe("10.5");
      });

      it("should handle integer quantity", () => {
        expect(b.toInternalQuantity(10)).toBe(1000n);
        expect(b.fromInternalQuantity(1000n)).toBe("10");
      });

      it("should throw on invalid format", () => {
        expect(() => b.toInternalQuantity("abc" as unknown as number)).toThrow(/Invalid format/);
      });

      it("should throw on excess precision", () => {
        expect(() => b.toInternalQuantity(10.123)).toThrow("more precision");
      });
    });

    describe("getBestAskPrice / getBestBidPrice", () => {
      it("should return best prices", () => {
        helperAdd(book, createTestOrder("ask1", Side.SELL, 11000n, 10n));
        helperAdd(book, createTestOrder("ask2", Side.SELL, 10500n, 20n));
        helperAdd(book, createTestOrder("bid1", Side.BUY, 10000n, 10n));
        helperAdd(book, createTestOrder("bid2", Side.BUY, 9500n, 20n));
        expect(book.getBestAskPrice()).toBe(10500n);
        expect(book.getBestBidPrice()).toBe(10000n);
      });

      it("should return 0 on empty", () => {
        expect(book.getBestAskPrice()).toBe(0n);
        expect(book.getBestBidPrice()).toBe(0n);
      });
    });

    describe("Complex Matching Scenarios", () => {
      it("should sweep multiple price levels with one large taker order", () => {
        const sell1 = new Order("sell1", Side.SELL, 10100n, 10n);
        const sell2 = new Order("sell2", Side.SELL, 10200n, 10n);
        const sell3 = new Order("sell3", Side.SELL, 10300n, 10n);
        helperAdd(book, sell1);
        helperAdd(book, sell2);
        helperAdd(book, sell3);

        const takerBuy = new Order("taker-buy", Side.BUY, 10300n, 25n);
        helperAdd(book, takerBuy);

        // Assert final states via mock listeners
        expect(orderListener.onFill).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "sell1",
            state: OrderState.FILLED,
            openQuantity: 0n,
          }),
          expect.any(Object),
        );
        expect(orderListener.onFill).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "sell2",
            state: OrderState.FILLED,
            openQuantity: 0n,
          }),
          expect.any(Object),
        );
        expect(orderListener.onFill).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "sell3",
            state: OrderState.PARTIALLY_FILLED,
            openQuantity: 5n,
          }),
          expect.any(Object),
        );
        expect(orderListener.onFill).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "taker-buy",
            state: OrderState.FILLED,
            openQuantity: 0n,
          }),
          expect.any(Object),
        );
        expect(tradeListener.onTrade).toHaveBeenCalledTimes(3);
      });

      it("should replace an order making it aggressive and causing an immediate match", () => {
        const buyOrder = new Order("buy-replace", Side.BUY, 10000n, 10n);
        const sellOrder = new Order("sell-resting", Side.SELL, 10200n, 10n);
        helperAdd(book, buyOrder);
        helperAdd(book, sellOrder);
        vi.clearAllMocks();

        book.replace(buyOrder.serverOrderId!, 10n, 10200n);

        expect(orderListener.onReplace).toHaveBeenCalledTimes(1);
        expect(tradeListener.onTrade).toHaveBeenCalledTimes(1);
        expect(orderListener.onFill).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "buy-replace",
            state: OrderState.FILLED,
          }),
          expect.any(Object),
        );
        expect(orderListener.onFill).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: "sell-resting",
            state: OrderState.FILLED,
          }),
          expect.any(Object),
        );
      });

      it("should reject replace with invalid tick size", () => {
        const bookWithTick = OrderBook.create("TEST", { tickSize: "5" });
        bookWithTick.setOrderListener(orderListener);
        const order = new Order("o1", Side.BUY, 10000n, 10n);
        helperAdd(bookWithTick, order);

        expect(() => bookWithTick.replace(order.serverOrderId!, 10n, 10003n)).toThrowError(
          /tick size/i,
        );
        expect(orderListener.onReplaceReject).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: "o1" }),
          OrderRejectReason.InvalidTickSize,
          expect.stringContaining("tick size"),
        );
      });
    });

    // MERGED FROM PREVIOUS FILE: Event Sequencing
    describe("Event Sequencing", () => {
      it("should call onTrade listener AFTER both order states are updated", () => {
        const makerOrder = new Order("maker1", Side.SELL, 10000n, 100n);
        helperAdd(book, makerOrder);

        let makerQtyOnTrade: Quantity | null = null;
        let takerInBookOnTrade: boolean | null = null;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        tradeListener.onTrade = vi.fn((book: OrderBook, _trade: TradeSnapshot) => {
          const maker = book.getOrder(makerOrder.serverOrderId!);
          const taker = book.getOrder(takerOrder.serverOrderId!);
          makerQtyOnTrade = maker?.openQuantity ?? -1n;
          // Filled taker orders are removed from orderMap
          takerInBookOnTrade = taker !== undefined;
        });

        const takerOrder = new Order("taker1", Side.BUY, 10000n, 40n);
        helperAdd(book, takerOrder);

        expect(makerQtyOnTrade).not.toBeNull();
        const expectedMakerQty = 100n - 40n;
        expect(makerQtyOnTrade!).toBe(expectedMakerQty);
        // Taker is fully filled (40n) and removed from orderMap
        expect(takerInBookOnTrade!).toBe(false);
        expect(takerOrder.openQuantity).toBe(0n);
        expect(takerOrder.state).toBe(OrderState.FILLED);
      });
    });
  });
});
