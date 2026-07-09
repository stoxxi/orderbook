// packages/orderbook/__tests__/limit.spec.ts
// Comprehensive tests for O(1) Intrusive Linked List Limit implementation

import { describe, expect, test } from "bun:test";
import { Limit } from "../src/limit";
import { Order } from "../src/order";
import { Side } from "../src/types";

describe("Limit (O(1) Linked List)", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // BASIC OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("addOrder", () => {
    test("should add order to empty limit", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);

      expect(limit.orderCount).toBe(1);
      expect(limit.totalQuantity).toBe(100n);
      expect(limit.peekFront()).toBe(order);
      expect(order._limit as unknown).toBe(limit as unknown);
    });

    test("should maintain FIFO order", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;

      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      expect(limit.peekFront()).toBe(o1);
      expect(limit.popFront()).toBe(o1);
      expect(limit.popFront()).toBe(o2);
      expect(limit.popFront()).toBe(o3);
    });

    test("should reject order without serverOrderId", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      // serverOrderId is null by default

      expect(() => limit.addOrder(order)).toThrow(/serverOrderId/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P0 INVARIANT: POINTER INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Pointer Integrity Invariant", () => {
    test("should maintain node._next._prev === node after additions", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;

      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      // Verify forward-backward integrity
      expect(o1._prev).toBeNull();
      expect(o1._next).toBe(o2);
      expect(o2._prev).toBe(o1);
      expect(o2._next).toBe(o3);
      expect(o3._prev).toBe(o2);
      expect(o3._next).toBeNull();

      // Verify the invariant: node._next._prev === node
      expect(o1._next?._prev).toBe(o1);
      expect(o2._next?._prev).toBe(o2);
    });

    test("should maintain pointer integrity after middle removal", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;

      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      // Remove middle
      limit.removeOrder(o2);

      // o1 and o3 should now be directly linked
      expect(o1._next).toBe(o3);
      expect(o3._prev).toBe(o1);

      // Removed order should have cleared pointers
      expect(o2._prev).toBeNull();
      expect(o2._next).toBeNull();
      expect(o2._limit).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P0 INVARIANT: DOUBLE-ENQUEUE GUARD
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Double-Enqueue Guard (P0)", () => {
    test("should throw when adding order already in this limit", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);

      // Attempt to add same order again
      expect(() => limit.addOrder(order)).toThrow(/INVARIANT VIOLATION/);
      expect(() => limit.addOrder(order)).toThrow(/already linked/);
    });

    test("should throw when adding order that belongs to different limit", () => {
      const limit1 = new Limit<Order>(10000n);
      const limit2 = new Limit<Order>(20000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit1.addOrder(order);

      // Attempt to add to second limit without removing from first
      expect(() => limit2.addOrder(order)).toThrow(/INVARIANT VIOLATION/);
      expect(() => limit2.addOrder(order)).toThrow(/already linked to Limit@10000/);
    });

    test("should allow re-adding order after proper removal", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      limit.removeOrder(order);

      // Should succeed after proper removal
      expect(() => limit.addOrder(order)).not.toThrow();
      expect(limit.orderCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P0 INVARIANT: DOUBLE-REMOVAL GUARD
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Double-Removal Guard (P0)", () => {
    test("should return false on second removal", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 10n);
      order.serverOrderId = 1n;

      limit.addOrder(order);

      // First removal succeeds
      expect(limit.removeOrder(order)).toBe(true);

      // Second removal fails (guards triggered)
      expect(limit.removeOrder(order)).toBe(false);

      // List is not corrupted
      expect(limit.orderCount).toBe(0);
      expect(limit.isEmpty()).toBe(true);
    });

    test("should return false for order with null serverOrderId", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 10n);
      // Note: serverOrderId is null - malformed order state

      const result = limit.removeOrder(order);

      expect(result).toBe(false);
    });

    test("should return false for order belonging to different limit", () => {
      const limit1 = new Limit<Order>(10000n);
      const limit2 = new Limit<Order>(20000n);
      const order = new Order("o1", Side.BUY, 10000n, 10n);
      order.serverOrderId = 1n;

      limit1.addOrder(order);

      // Try to remove from wrong limit
      const result = limit2.removeOrder(order);

      expect(result).toBe(false);
      expect(limit1.orderCount).toBe(1); // Still in limit1
    });

    test("should return false for order never added", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 10n);
      order.serverOrderId = 1n;

      const result = limit.removeOrder(order);

      expect(result).toBe(false);
    });

    test("should clear order pointers after removal", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 10n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      limit.removeOrder(order);

      expect(order._prev).toBeNull();
      expect(order._next).toBeNull();
      expect(order._limit).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P0 INVARIANT: QUANTITY AGGREGATE CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Quantity Aggregate Consistency (P0)", () => {
    test("should throw on quantity underflow during removal", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);

      // Simulate buggy code that mutates openQuantity without updateQuantity
      // This should NEVER happen in correct code, but we guard against it
      (order as any).openQuantity = 200n; // Bug: doubled without telling Limit

      expect(() => limit.removeOrder(order)).toThrow(/INVARIANT VIOLATION/);
      expect(() => limit.removeOrder(order)).toThrow(/underflow/);
    });

    test("should maintain correct totalQuantity through partial fills", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      expect(limit.totalQuantity).toBe(100n);

      // Simulate partial fill: reduce openQuantity and call updateQuantity
      order.openQuantity = 60n;
      limit.updateQuantity(-40n);

      expect(limit.totalQuantity).toBe(60n);

      // Removal should work correctly
      limit.removeOrder(order);
      expect(limit.totalQuantity).toBe(0n);
    });

    test("totalQuantity should equal sum of openQuantity", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;

      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      expect(limit.totalQuantity).toBe(60n); // 10 + 20 + 30

      limit.removeOrder(o2);
      expect(limit.totalQuantity).toBe(40n); // 10 + 30
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P0 INVARIANT: HEAD/TAIL CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Head/Tail Consistency (P0)", () => {
    test("isEmpty should be true when head and tail are null", () => {
      const limit = new Limit<Order>(10000n);
      expect(limit.isEmpty()).toBe(true);
    });

    test("should have consistent head/tail after removing last element", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      expect(limit.isEmpty()).toBe(false);

      limit.removeOrder(order);
      expect(limit.isEmpty()).toBe(true);
      expect(limit.peekFront()).toBeUndefined();
    });

    test("should have consistent head/tail after popFront of last element", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      const popped = limit.popFront();

      expect(popped).toBe(order);
      expect(limit.isEmpty()).toBe(true);
      expect(limit.orderCount).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REMOVAL OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("removeOrder (O(1))", () => {
    test("should remove from middle of queue in O(1)", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;

      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      // Remove middle
      const removed = limit.removeOrder(o2);

      expect(removed).toBe(true);
      expect(limit.orderCount).toBe(2);
      expect(limit.totalQuantity).toBe(40n); // 10 + 30

      expect(limit.popFront()).toBe(o1);
      expect(limit.popFront()).toBe(o3);
    });

    test("should remove head correctly", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;

      limit.addOrder(o1);
      limit.addOrder(o2);

      limit.removeOrder(o1);

      expect(limit.peekFront()).toBe(o2);
      expect(o2._prev).toBeNull();
      expect(limit.orderCount).toBe(1);
    });

    test("should remove tail correctly", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;

      limit.addOrder(o1);
      limit.addOrder(o2);

      limit.removeOrder(o2);

      expect(limit.peekFront()).toBe(o1);
      expect(o1._next).toBeNull();
      expect(limit.popFront()).toBe(o1);
      expect(limit.isEmpty()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POPFRONT (DRY PATTERN)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("popFront (DRY via removeOrder)", () => {
    test("should return undefined for empty limit", () => {
      const limit = new Limit<Order>(10000n);
      expect(limit.popFront()).toBeUndefined();
    });

    test("should update totalQuantity on pop", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      const popped = limit.popFront();

      expect(popped).toBe(order);
      expect(limit.totalQuantity).toBe(0n);
      expect(limit.orderCount).toBe(0);
    });

    test("should clear pointers on popped order", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      limit.popFront();

      expect(order._prev).toBeNull();
      expect(order._next).toBeNull();
      expect(order._limit).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Single Element Edge Cases", () => {
    test("should handle single element add and remove", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      expect(limit.orderCount).toBe(1);

      limit.removeOrder(order);
      expect(limit.orderCount).toBe(0);
      expect(limit.isEmpty()).toBe(true);
    });

    test("should handle single element popFront", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;

      limit.addOrder(order);
      const popped = limit.popFront();

      expect(popped).toBe(order);
      expect(limit.isEmpty()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBUG UTILITIES (P2)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Debug Utilities (P2)", () => {
    test("forEach should iterate in queue order", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;

      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      const visited: Array<{ order: Order; index: number }> = [];
      limit.forEach((order, index) => {
        visited.push({ order, index });
      });

      expect(visited).toHaveLength(3);
      expect(visited[0]).toEqual({ order: o1, index: 0 });
      expect(visited[1]).toEqual({ order: o2, index: 1 });
      expect(visited[2]).toEqual({ order: o3, index: 2 });
    });

    test("forEach should handle empty limit", () => {
      const limit = new Limit<Order>(10000n);
      const visited: Order[] = [];

      limit.forEach((order) => visited.push(order));

      expect(visited).toHaveLength(0);
    });

    test("toArray should return orders in queue order", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;

      limit.addOrder(o1);
      limit.addOrder(o2);

      const arr = limit.toArray();

      expect(arr).toEqual([o1, o2]);
    });

    test("toArray should return empty array for empty limit", () => {
      const limit = new Limit<Order>(10000n);
      expect(limit.toArray()).toEqual([]);
    });

    test("forEach should be safe if callback throws (no mutation)", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;

      limit.addOrder(o1);
      limit.addOrder(o2);

      // Callback throws after first order
      expect(() => {
        limit.forEach((_order, index) => {
          if (index === 0) throw new Error("test error");
        });
      }).toThrow("test error");

      // List should be unchanged
      expect(limit.orderCount).toBe(2);
      expect(limit.toArray()).toEqual([o1, o2]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTRUCTOR VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Constructor", () => {
    test("should accept valid non-negative price", () => {
      expect(() => new Limit<Order>(0n)).not.toThrow();
      expect(() => new Limit<Order>(100n)).not.toThrow();
      expect(() => new Limit<Order>(999999n)).not.toThrow();
    });

    test("should reject negative price", () => {
      expect(() => new Limit<Order>(-1n)).toThrow(/non-negative/);
    });

    test("should reject null price", () => {
      expect(() => new Limit<Order>(null as any)).toThrow(/non-negative/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P0: CYCLE DETECTION GUARD (Fatal Corruption Prevention)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cycle Detection Guard (P0)", () => {
    test("should throw FatalEngineError on cyclic _next pointer", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;
      limit.addOrder(order);

      // Manually corrupt the list to create a cycle (_next points to self)
      order._next = order;

      // Attempting to remove should detect the cycle and throw
      expect(() => limit.removeOrder(order)).toThrow(/Cyclic pointer detected/);
    });

    test("should throw FatalEngineError on cyclic _prev pointer", () => {
      const limit = new Limit<Order>(10000n);
      const order = new Order("o1", Side.BUY, 10000n, 100n);
      order.serverOrderId = 1n;
      limit.addOrder(order);

      // Manually corrupt the list to create a cycle (_prev points to self)
      order._prev = order;

      // Attempting to remove should detect the cycle and throw
      expect(() => limit.removeOrder(order)).toThrow(/Cyclic pointer detected/);
    });

    test("should not throw for valid non-cyclic pointers", () => {
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;

      limit.addOrder(o1);
      limit.addOrder(o2);

      // Valid pointers: o1._next = o2, o2._prev = o1
      // Removal should succeed without throwing
      expect(() => limit.removeOrder(o1)).not.toThrow();
      expect(limit.orderCount).toBe(1);
    });
  });

  describe("Iterator Cycle Guard (MED-2)", () => {
    test("[Symbol.iterator] throws when linked-list develops a cycle (defense-in-depth)", () => {
      // sandbox.ts's hashRelevantLiveState walks Limit's iterator on the
      // hot path. A pointer-integrity bug elsewhere (e.g. a future
      // refactor of addOrder/removeOrder) that creates a cycle would
      // hang CI/prod. Bound the walk to 2× orderCount and throw.
      const limit = new Limit<Order>(10000n);
      const o1 = new Order("o1", Side.BUY, 10000n, 10n);
      const o2 = new Order("o2", Side.BUY, 10000n, 20n);
      const o3 = new Order("o3", Side.BUY, 10000n, 30n);
      o1.serverOrderId = 1n;
      o2.serverOrderId = 2n;
      o3.serverOrderId = 3n;
      limit.addOrder(o1);
      limit.addOrder(o2);
      limit.addOrder(o3);

      // Force a cycle: tail._next → head. Bypasses the public API
      // (which preserves the invariant) — simulates a hypothetical
      // future bug.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o3 as any)._next = o1;

      expect(() => {
        for (const _o of limit) {
          // Drain the iterator. With the guard the throw fires before
          // the test hangs; without it this loop would never exit.
        }
      }).toThrow(/cycle detected/);
    });

    test("[Symbol.iterator] yields all orders for a healthy chain (no false positive)", () => {
      const limit = new Limit<Order>(10000n);
      for (let i = 1; i <= 5; i++) {
        const o = new Order(`o${i}`, Side.BUY, 10000n, BigInt(i * 10));
        o.serverOrderId = BigInt(i);
        limit.addOrder(o);
      }
      const ids: string[] = [];
      for (const o of limit) ids.push(o.orderId);
      expect(ids).toEqual(["o1", "o2", "o3", "o4", "o5"]);
    });
  });
});
