// packages/orderbook/__tests__/durability.spec.ts
// P1: Post-Replay Invariant Verification Tests
//
// These tests verify that assertPostReplayInvariants() correctly detects
// corruption after WAL replay. This is critical for catching latent bugs
// before they cause financial loss.

import { describe, test, expect, beforeEach } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";
import { FatalEngineError } from "../src/errors";

describe("P1: Post-Replay Invariant Verification", () => {
  let book: OrderBook<Order>;

  beforeEach(() => {
    book = OrderBook.create("TEST");
  });

  describe("Invariant 1: Ownership Consistency (_limit pointer)", () => {
    test("should throw FatalEngineError when order._limit points to wrong Limit", async () => {
      // Setup: Add orders at two different price levels
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 9900n, 100n);
      helperAdd(book, order1);
      helperAdd(book, order2);

      // Corruption: Make order1._limit point to null (orphaned order)
      // This simulates corruption where an order claims wrong ownership
      (order1 as any)._limit = null;

      // Verify: recover() should detect the corruption
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/RECOVERY FAILURE.*wrong Limit/);
    });

    test("should throw FatalEngineError when order._limit points to different Limit", async () => {
      // Setup: Add orders at two different price levels
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 9900n, 100n);
      helperAdd(book, order1);
      helperAdd(book, order2);

      // Get reference to order2's limit
      const order2Limit = (order2 as any)._limit;

      // Corruption: Make order1 claim it belongs to order2's limit
      (order1 as any)._limit = order2Limit;

      // Verify: recover() should detect the cross-limit corruption
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/RECOVERY FAILURE.*wrong Limit/);
    });
  });

  describe("Invariant 2: Doubly-Linked List Integrity (_prev pointer)", () => {
    test("should throw FatalEngineError when _prev pointer is corrupted", async () => {
      // Setup: Add multiple orders at same price level to create a linked list
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 10000n, 100n);
      const order3 = new Order("o3", Side.BUY, 10000n, 100n);
      helperAdd(book, order1);
      helperAdd(book, order2);
      helperAdd(book, order3);

      // Verify initial state: order2._prev should point to order1
      expect((order2 as any)._prev).toBe(order1);

      // Corruption: Break the _prev pointer chain
      (order2 as any)._prev = null; // Should be order1

      // Verify: recover() should detect the DLL corruption
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/DLL prev pointer corruption/);
    });

    test("should throw FatalEngineError when _prev points to wrong order", async () => {
      // Setup: Add multiple orders
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 10000n, 100n);
      const order3 = new Order("o3", Side.BUY, 10000n, 100n);
      helperAdd(book, order1);
      helperAdd(book, order2);
      helperAdd(book, order3);

      // Corruption: Make order3._prev skip order2
      (order3 as any)._prev = order1; // Should be order2

      // Verify: recover() should detect the pointer skip
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/DLL prev pointer corruption/);
    });
  });

  describe("Invariant 3: No Self-Cycles (_next pointer)", () => {
    test("should throw FatalEngineError when _next creates self-cycle", async () => {
      // Setup: Add an order
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      helperAdd(book, order1);

      // Corruption: Create a self-referential cycle
      (order1 as any)._next = order1;

      // Verify: recover() should detect the cycle
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/Cyclic pointer detected/);
    });
  });

  describe("Invariant 4: Head/Tail Correctness", () => {
    test("should throw FatalEngineError when tail pointer is corrupted", async () => {
      // Setup: Add orders
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 10000n, 100n);
      helperAdd(book, order1);
      helperAdd(book, order2);

      // Get the limit
      const limit = (order1 as any)._limit;

      // Corruption: Make tail point to wrong order
      limit.tail = order1; // Should be order2

      // Verify: recover() should detect tail mismatch
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/Limit tail mismatch/);
    });
  });

  describe("Invariant 5: Aggregate Correctness", () => {
    test("should throw FatalEngineError when totalQuantity drifts", async () => {
      // Setup: Add orders
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 10000n, 200n);
      helperAdd(book, order1);
      helperAdd(book, order2);

      // Get the limit and verify expected state
      const limit = (order1 as any)._limit;
      expect(limit.totalQuantity).toBe(300n);

      // Corruption: Manually corrupt totalQuantity
      limit.totalQuantity = 500n; // Should be 300n

      // Verify: recover() should detect quantity drift
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/Quantity drift/);
    });

    test("should throw FatalEngineError when orderCount drifts", async () => {
      // Setup: Add orders
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 10000n, 100n);
      helperAdd(book, order1);
      helperAdd(book, order2);

      // Get the limit
      const limit = (order1 as any)._limit;
      expect(limit.orderCount).toBe(2);

      // Corruption: Manually corrupt orderCount
      (limit as any)._orderCount = 5; // Should be 2

      // Verify: recover() should detect count drift
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
      await expect(book.recover()).rejects.toThrow(/Order count drift/);
    });
  });

  describe("Multi-Side Corruption Detection", () => {
    test("should detect corruption on ask side", async () => {
      // Setup: Add sell orders
      const sell1 = new Order("s1", Side.SELL, 11000n, 100n);
      const sell2 = new Order("s2", Side.SELL, 11000n, 100n);
      helperAdd(book, sell1);
      helperAdd(book, sell2);

      // Corruption: Break the _prev pointer on ask side
      (sell2 as any)._prev = null;

      // Verify: recover() should detect corruption on asks too
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
    });

    test("should detect corruption across both sides", async () => {
      // Setup: Add orders on both sides
      const buy1 = new Order("b1", Side.BUY, 10000n, 100n);
      const sell1 = new Order("s1", Side.SELL, 11000n, 100n);
      helperAdd(book, buy1);
      helperAdd(book, sell1);

      // Corruption: Corrupt the bid side
      (buy1 as any)._limit = null;

      // Verify: recover() should detect corruption
      await expect(book.recover()).rejects.toThrow(FatalEngineError);
    });
  });

  describe("Clean State Verification", () => {
    test("should pass invariant check for uncorrupted state", async () => {
      // Setup: Add orders normally without corruption
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.BUY, 10000n, 200n);
      const order3 = new Order("o3", Side.SELL, 11000n, 150n);
      helperAdd(book, order1);
      helperAdd(book, order2);
      helperAdd(book, order3);

      // Verify: recover() should pass without errors
      await expect(book.recover()).resolves.toBeUndefined();
    });

    test("should pass invariant check for empty book", async () => {
      // Verify: recover() should pass on empty book
      await expect(book.recover()).resolves.toBeUndefined();
    });

    test("should pass invariant check after normal order operations", async () => {
      // Setup: Perform normal order lifecycle
      const order1 = new Order("o1", Side.BUY, 10000n, 100n);
      const order2 = new Order("o2", Side.SELL, 10000n, 50n); // Partial fill
      helperAdd(book, order1);
      helperAdd(book, order2); // order2 fills against order1

      // Order1 should be partially filled, still in book
      expect(order1.openQuantity).toBe(50n);

      // Verify: recover() should pass for valid state
      await expect(book.recover()).resolves.toBeUndefined();
    });
  });
});
