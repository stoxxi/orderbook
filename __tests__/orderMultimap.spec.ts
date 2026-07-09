// packages/orderbook/__tests__/orderMultimap.spec.ts
// P2: OrderMultiMap Tests
//
// Tests for the core data structure that stores orders grouped by price level.
// Verifies correct behavior of insertion, removal, and data integrity checks.

import { describe, test, expect, beforeEach } from "bun:test";
import { OrderMultiMap } from "../src/orderMultimap";
import { Order } from "../src/order";
import { Side } from "../src/types";

describe("OrderMultiMap", () => {
  let map: OrderMultiMap<Order>;

  beforeEach(() => {
    map = new OrderMultiMap<Order>();
  });

  // Helper to create and prepare an order for insertion
  function createOrder(
    id: string,
    price: bigint,
    quantity: bigint,
    serverOrderId?: bigint
  ): Order {
    const order = new Order(id, Side.BUY, price, quantity);
    order.serverOrderId = serverOrderId ?? BigInt(Math.floor(Math.random() * 1000000));
    return order;
  }

  describe("insert", () => {
    test("should insert order at new price level", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      expect(map.size()).toBe(1);
      expect(map.get(10000n)).toBeDefined();
      expect(map.get(10000n)!.totalQuantity).toBe(100n);
    });

    test("should insert multiple orders at same price level", () => {
      const o1 = createOrder("o1", 10000n, 100n);
      const o2 = createOrder("o2", 10000n, 200n);

      map.insert(o1);
      map.insert(o2);

      expect(map.size()).toBe(1); // Single price level
      expect(map.get(10000n)!.totalQuantity).toBe(300n);
      expect(map.get(10000n)!.orderCount).toBe(2);
    });

    test("should insert orders at different price levels", () => {
      const o1 = createOrder("o1", 10000n, 100n);
      const o2 = createOrder("o2", 10100n, 200n);
      const o3 = createOrder("o3", 9900n, 150n);

      map.insert(o1);
      map.insert(o2);
      map.insert(o3);

      expect(map.size()).toBe(3);
      expect(map.get(10000n)!.totalQuantity).toBe(100n);
      expect(map.get(10100n)!.totalQuantity).toBe(200n);
      expect(map.get(9900n)!.totalQuantity).toBe(150n);
    });

    test("should throw on null order", () => {
      expect(() => map.insert(null as any)).toThrow(/cannot be null/);
    });

    test("should throw on undefined order", () => {
      expect(() => map.insert(undefined as any)).toThrow(/cannot be null/);
    });
  });

  describe("get", () => {
    test("should return Limit for existing price", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      const limit = map.get(10000n);
      expect(limit).toBeDefined();
      expect(limit!.price).toBe(10000n);
    });

    test("should return undefined for non-existent price", () => {
      expect(map.get(99999n)).toBeUndefined();
    });

    test("should throw on null price", () => {
      expect(() => map.get(null as any)).toThrow(/cannot be null/);
    });

    test("should throw on undefined price", () => {
      expect(() => map.get(undefined as any)).toThrow(/cannot be null/);
    });
  });

  describe("remove", () => {
    test("should remove order from price level", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      const result = map.remove(order);

      expect(result).toBe(true);
      expect(map.size()).toBe(0); // Price level removed when empty
    });

    test("should remove price level when last order removed", () => {
      const o1 = createOrder("o1", 10000n, 100n);
      const o2 = createOrder("o2", 10000n, 200n);
      map.insert(o1);
      map.insert(o2);

      map.remove(o1);
      expect(map.size()).toBe(1);
      expect(map.get(10000n)!.totalQuantity).toBe(200n);

      map.remove(o2);
      expect(map.size()).toBe(0);
      expect(map.get(10000n)).toBeUndefined();
    });

    test("should return false for non-existent order", () => {
      const order = createOrder("o1", 10000n, 100n);
      // Don't insert it
      expect(map.remove(order)).toBe(false);
    });

    test("should throw on null order", () => {
      expect(() => map.remove(null as any)).toThrow(/cannot be null/);
    });

    test("should detect data corruption (empty queue with non-zero quantity)", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      // Manually corrupt the limit's totalQuantity
      const limit = map.get(10000n)!;
      (limit as any).totalQuantity = 500n; // Corrupt!

      // Remove should detect corruption when limit becomes empty
      // but totalQuantity != 0
      expect(() => map.remove(order)).toThrow(/Data corruption detected/);
    });
  });

  describe("updateQuantity", () => {
    test("should update quantity for existing order", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      map.updateQuantity(order, -50n);

      expect(map.get(10000n)!.totalQuantity).toBe(50n);
    });

    test("should handle positive delta", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      map.updateQuantity(order, 50n);

      expect(map.get(10000n)!.totalQuantity).toBe(150n);
    });

    test("should skip no-op (zero delta)", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      map.updateQuantity(order, 0n);

      expect(map.get(10000n)!.totalQuantity).toBe(100n);
    });

    test("should throw for non-existent price level", () => {
      const order = createOrder("o1", 10000n, 100n);
      // Don't insert

      expect(() => map.updateQuantity(order, -50n)).toThrow(
        /non-existent price level/
      );
    });

    test("should throw on null order", () => {
      expect(() => map.updateQuantity(null as any, -50n)).toThrow(
        /cannot be null/
      );
    });

    test("should detect negative quantity (data corruption)", () => {
      const order = createOrder("o1", 10000n, 100n);
      map.insert(order);

      expect(() => map.updateQuantity(order, -200n)).toThrow(
        /negative total quantity/
      );
    });

    test("should detect inconsistent state (zero qty but orders present)", () => {
      const o1 = createOrder("o1", 10000n, 100n);
      const o2 = createOrder("o2", 10000n, 100n);
      map.insert(o1);
      map.insert(o2);

      // This would create an inconsistent state:
      // totalQuantity = 0 but orderCount = 2
      expect(() => map.updateQuantity(o1, -200n)).toThrow(
        /zero total quantity but.*orders still present/
      );
    });
  });

  describe("getBest", () => {
    test("should return lowest price Limit", () => {
      map.insert(createOrder("o1", 10000n, 100n));
      map.insert(createOrder("o2", 9900n, 100n));
      map.insert(createOrder("o3", 10100n, 100n));

      const best = map.getBest();
      expect(best).toBeDefined();
      expect(best!.price).toBe(9900n);
    });

    test("should return undefined for empty map", () => {
      expect(map.getBest()).toBeUndefined();
    });
  });

  describe("getBestReverse", () => {
    test("should return highest price Limit", () => {
      map.insert(createOrder("o1", 10000n, 100n));
      map.insert(createOrder("o2", 9900n, 100n));
      map.insert(createOrder("o3", 10100n, 100n));

      const best = map.getBestReverse();
      expect(best).toBeDefined();
      expect(best!.price).toBe(10100n);
    });

    test("should return undefined for empty map", () => {
      expect(map.getBestReverse()).toBeUndefined();
    });
  });

  describe("size", () => {
    test("should return 0 for empty map", () => {
      expect(map.size()).toBe(0);
    });

    test("should return number of price levels", () => {
      map.insert(createOrder("o1", 10000n, 100n));
      map.insert(createOrder("o2", 10000n, 100n)); // Same level
      map.insert(createOrder("o3", 10100n, 100n)); // Different level

      expect(map.size()).toBe(2);
    });
  });

  describe("forward iterator", () => {
    test("should iterate in ascending price order", () => {
      map.insert(createOrder("o1", 10000n, 100n));
      map.insert(createOrder("o2", 9900n, 100n));
      map.insert(createOrder("o3", 10100n, 100n));

      const prices: bigint[] = [];
      for (const limit of map.forward()) {
        prices.push(limit.price);
      }

      expect(prices).toEqual([9900n, 10000n, 10100n]);
    });

    test("should handle empty map", () => {
      const prices: bigint[] = [];
      for (const limit of map.forward()) {
        prices.push(limit.price);
      }

      expect(prices).toEqual([]);
    });
  });

  describe("backward iterator", () => {
    test("should iterate in descending price order", () => {
      map.insert(createOrder("o1", 10000n, 100n));
      map.insert(createOrder("o2", 9900n, 100n));
      map.insert(createOrder("o3", 10100n, 100n));

      const prices: bigint[] = [];
      for (const limit of map.backward()) {
        prices.push(limit.price);
      }

      expect(prices).toEqual([10100n, 10000n, 9900n]);
    });

    test("should handle empty map", () => {
      const prices: bigint[] = [];
      for (const limit of map.backward()) {
        prices.push(limit.price);
      }

      expect(prices).toEqual([]);
    });
  });

  describe("removePriceLevel", () => {
    test("should remove price level directly", () => {
      map.insert(createOrder("o1", 10000n, 100n));
      map.insert(createOrder("o2", 10100n, 100n));

      map.removePriceLevel(10000n);

      expect(map.size()).toBe(1);
      expect(map.get(10000n)).toBeUndefined();
      expect(map.get(10100n)).toBeDefined();
    });

    test("should handle non-existent price level", () => {
      // Should not throw
      map.removePriceLevel(99999n);
      expect(map.size()).toBe(0);
    });
  });

  describe("Integration Scenarios", () => {
    test("should handle typical order book operations", () => {
      // Simulate order book activity
      const o1 = createOrder("o1", 10000n, 100n);
      const o2 = createOrder("o2", 10000n, 200n);
      const o3 = createOrder("o3", 9900n, 150n);

      // Add orders
      map.insert(o1);
      map.insert(o2);
      map.insert(o3);

      expect(map.size()).toBe(2);
      expect(map.get(10000n)!.totalQuantity).toBe(300n);
      expect(map.get(9900n)!.totalQuantity).toBe(150n);

      // Cancel o3
      map.remove(o3);
      expect(map.size()).toBe(1);
      expect(map.get(9900n)).toBeUndefined();

      // Cancel o1 (one order remaining at 10000)
      map.remove(o1);
      expect(map.size()).toBe(1);
      expect(map.get(10000n)!.totalQuantity).toBe(200n);

      // Cancel o2 (last order at 10000)
      map.remove(o2);
      expect(map.size()).toBe(0);
    });

    test("should maintain sorted order through modifications", () => {
      // Insert in random order
      map.insert(createOrder("o5", 10500n, 100n));
      map.insert(createOrder("o1", 10100n, 100n));
      map.insert(createOrder("o3", 10300n, 100n));
      map.insert(createOrder("o2", 10200n, 100n));
      map.insert(createOrder("o4", 10400n, 100n));

      // Should iterate in sorted order
      const prices: bigint[] = [];
      for (const limit of map.forward()) {
        prices.push(limit.price);
      }

      expect(prices).toEqual([10100n, 10200n, 10300n, 10400n, 10500n]);
    });
  });
});
