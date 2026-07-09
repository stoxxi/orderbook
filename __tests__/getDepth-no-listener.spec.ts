// packages/orderbook/__tests__/getDepth-no-listener.spec.ts
//
// Regression tests for the listener-less getDepth() staleness bug:
// rebuildDepth() used to early-return AND clear `depthIsDirty` when no
// depthListener was attached, so the public getDepth() returned a
// never-rebuilt (empty/stale) snapshot. The rebuild must be lazy (no
// rebuild on the mutation hot path without a listener) but getDepth()
// must always observe fresh state.

import { describe, expect, it } from "bun:test";
import type { Depth } from "../src/depth";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";
import { helperAdd } from "./_helpers";

function makeBook() {
  return OrderBook.create("TEST", { pricePrecision: 2, quantityPrecision: 0 });
}

const px = (b: OrderBook) => (p: number | string) => b.toInternalPrice(p);

describe("getDepth() without a depth listener", () => {
  it("returns fresh levels after mutations with no listener attached", () => {
    const book = makeBook();
    const P = px(book);

    helperAdd(book, new Order("b1", Side.BUY, P(100), 10n));
    helperAdd(book, new Order("a1", Side.SELL, P(101), 5n));

    const depth = book.getDepth();
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]).toEqual({ price: P(100), quantity: 10n, orderCount: 1 });
    expect(depth.asks).toHaveLength(1);
    expect(depth.asks[0]).toEqual({ price: P(101), quantity: 5n, orderCount: 1 });
  });

  it("stays fresh across repeated mutate → getDepth cycles", () => {
    const book = makeBook();
    const P = px(book);

    helperAdd(book, new Order("b1", Side.BUY, P(100), 10n));
    expect(book.getDepth().bids).toHaveLength(1);

    // Mutate again AFTER a getDepth() (dirty flag was just cleared)
    helperAdd(book, new Order("b2", Side.BUY, P(99), 7n));
    helperAdd(book, new Order("a1", Side.SELL, P(102), 3n));

    const depth = book.getDepth();
    expect(depth.bids).toHaveLength(2);
    expect(depth.bids[0].price).toBe(P(100)); // best bid first (descending)
    expect(depth.bids[1]).toEqual({ price: P(99), quantity: 7n, orderCount: 1 });
    expect(depth.asks).toHaveLength(1);
    expect(depth.asks[0]).toEqual({ price: P(102), quantity: 3n, orderCount: 1 });
  });

  it("attaching a listener after mutations yields a fresh first notification and fresh getDepth", () => {
    const book = makeBook();
    const P = px(book);

    // Mutate while no listener is attached
    helperAdd(book, new Order("b1", Side.BUY, P(100), 10n));
    helperAdd(book, new Order("a1", Side.SELL, P(101), 5n));

    const notifications: Depth[] = [];
    book.setDepthListener({
      onDepthChange: (_book, depth) => {
        notifications.push(depth);
      },
    });

    // Next mutation must notify with the FULL book state (not just the delta
    // since attach) — setDepthListener marks depth dirty defensively.
    helperAdd(book, new Order("b2", Side.BUY, P(99), 7n));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].bids).toHaveLength(2);
    expect(notifications[0].asks).toHaveLength(1);

    const depth = book.getDepth();
    expect(depth.bids).toHaveLength(2);
    expect(depth.asks).toHaveLength(1);
  });
});
