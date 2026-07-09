import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

describe("WAL Replay Invariants (Phase 2)", () => {
  test("no zombie orders after replay", () => {
    const book = OrderBook.create("TEST");

    // Simulate WAL-replayed orders
    const o1 = new Order("o1", Side.BUY, 10000n, 10n);
    const o2 = new Order("o2", Side.BUY, 10000n, 20n);

    o1.serverOrderId = 1n;
    o2.serverOrderId = 2n;

    // Replay ADDs
    helperAdd(book, o1);
    helperAdd(book, o2);

    // Replay CANCEL
    book.cancel(1n);

    // Invariant check: iterate live orders
    const limit = (book as any).bids.get(10000n);
    expect(limit).toBeDefined();

    let count = 0;
    let current = (limit as any).head;

    while (current !== null) {
      // Every order reachable from the limit MUST point back to it
      expect(current._limit).toBe(limit);
      count++;
      current = current._next;
    }

    // Only o2 should remain
    expect(count).toBe(1);
    expect(o1._limit).toBeNull();
    expect(o2._limit as unknown).toBe(limit as unknown);
  });

  test("fail-fast if replay leaves orphaned ownership", () => {
    const book = OrderBook.create("TEST");

    const o1 = new Order("o1", Side.BUY, 10000n, 10n);
    o1.serverOrderId = 1n;

    helperAdd(book, o1);

    // Simulate corrupted replay state
    const limit = (book as any).bids.get(10000n)!;
    (o1 as any)._limit = limit;
    (o1 as any)._prev = null;
    (o1 as any)._next = null;

    // Remove from list without clearing pointer (corruption)
    (limit as any).head = null;
    (limit as any).tail = null;

    // Invariant enforcement
    expect(() => {
      let current = (limit as any).head;
      while (current !== null) {
        if (current._limit !== limit) {
          throw new Error("Invariant violation: zombie order detected");
        }
        current = current._next;
      }

      if (o1._limit === limit && limit.isEmpty()) {
        throw new Error("Invariant violation: orphaned order ownership");
      }
    }).toThrow(/Invariant violation/);
  });

  test("cancel all orders at a price level removes empty Limit from tree", () => {
    const book = OrderBook.create("TEST");

    // Place two BUY orders at the same price
    const o1 = new Order("o1", Side.BUY, 10000n, 10n);
    const o2 = new Order("o2", Side.BUY, 10000n, 20n);
    o1.serverOrderId = 1n;
    o2.serverOrderId = 2n;
    helperAdd(book, o1);
    helperAdd(book, o2);

    const bids = (book as any).bids;
    expect(bids.size()).toBe(1); // One price level

    // Cancel both orders
    book.cancel(1n);
    book.cancel(2n);

    // The empty price level must be removed from the tree.
    // Before the fix, the Limit remained as a "zombie" with totalQuantity=0,
    // causing matchOrder's outer loop to spin infinitely.
    expect(bids.size()).toBe(0);
    expect(bids.get(10000n)).toBeUndefined();
  });

  test("zombie empty Limit causes infinite loop in matchOrder without fix", () => {
    const book = OrderBook.create("TEST");

    // Place a BUY limit order and cancel it — creates empty price level (now fixed)
    const bid = new Order("bid1", Side.BUY, 10000n, 5n);
    bid.serverOrderId = 1n;
    helperAdd(book, bid);
    book.cancel(1n);

    // Place a SELL market order — should NOT hang
    // Before the fix, this would loop infinitely because:
    // - bookToMatch.size() > 0 (zombie Limit in bids tree)
    // - bestLimit.isEmpty() === true (no orders at that level)
    // - Inner loop never executes, outer loop never exits
    const sell = new Order("sell1", Side.SELL, 0n, 5n);
    sell.serverOrderId = 2n;

    // This must complete without hanging (the fix removes empty Limits in cancel())
    const result = helperAdd(book, sell);
    // No match (the bid was canceled) → the market order is IOC, so its
    // residual is CANCELED, not resting (status = final order state).
    expect(result.status).toBe("CANCELED");
    expect(result.fills).toHaveLength(0);
  });
});
