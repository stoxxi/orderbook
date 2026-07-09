// packages/orderbook/__tests__/getBbo.spec.ts
// Tests for OrderBook.getBbo() public getter and bboLastUpdateTs tracking

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { createInstrument, Order, OrderBook, Side } from "../src";

function makeBook() {
  const instrument = createInstrument("TEST.A" as any, 0, 0, "1" as any, "1" as any, "999999999999999" as any);
  return new OrderBook(instrument);
}

const buy = (id: string, price: bigint, qty: bigint) => new Order(id, Side.BUY, price, qty);
const sell = (id: string, price: bigint, qty: bigint) => new Order(id, Side.SELL, price, qty);

describe("OrderBook.getBbo()", () => {
  test("returns zero BBO on empty book", () => {
    const book = makeBook();
    const bbo = book.getBbo();

    expect(bbo.bidPrice).toBe(0n);
    expect(bbo.bidQuantity).toBe(0n);
    expect(bbo.askPrice).toBe(0n);
    expect(bbo.askQuantity).toBe(0n);
    expect(bbo.lastUpdateTs).toBe(0);
  });

  test("returns correct BBO after adding a buy order", () => {
    const book = makeBook();

    helperAdd(book, buy("order-1", 50n, 100n), 1000);

    const bbo = book.getBbo();
    expect(bbo.bidPrice).toBe(50n);
    expect(bbo.bidQuantity).toBe(100n);
    expect(bbo.askPrice).toBe(0n);
    expect(bbo.askQuantity).toBe(0n);
    // lastUpdateTs reflects the injected logical timestamp (not wall-clock).
    expect(bbo.lastUpdateTs).toBe(1000);
  });

  test("returns correct BBO after adding buy and sell orders", () => {
    const book = makeBook();

    helperAdd(book, buy("buy-1", 50n, 100n));
    helperAdd(book, sell("sell-1", 60n, 200n));

    const bbo = book.getBbo();
    expect(bbo.bidPrice).toBe(50n);
    expect(bbo.bidQuantity).toBe(100n);
    expect(bbo.askPrice).toBe(60n);
    expect(bbo.askQuantity).toBe(200n);
  });

  test("updates lastUpdateTs on BBO change", () => {
    const book = makeBook();

    helperAdd(book, buy("buy-1", 50n, 100n), 1000);
    const ts1 = book.getBbo().lastUpdateTs;
    expect(ts1).toBe(1000);

    // A later logical timestamp advances lastUpdateTs deterministically.
    helperAdd(book, buy("buy-2", 55n, 50n), 2000);
    const ts2 = book.getBbo().lastUpdateTs;
    expect(ts2).toBeGreaterThan(ts1);
  });

  test("returns immutable copy — mutations don't affect internal state", () => {
    const book = makeBook();

    helperAdd(book, buy("buy-1", 50n, 100n));

    const bbo1 = book.getBbo();
    (bbo1 as any).bidPrice = 999n;

    const bbo2 = book.getBbo();
    expect(bbo2.bidPrice).toBe(50n);
  });

  test("BBO reverts to zero when last order is cancelled", () => {
    const book = makeBook();

    const result = helperAdd(book, buy("buy-1", 50n, 100n), 1000);
    expect(book.getBbo().bidPrice).toBe(50n);
    expect(book.getBbo().bidQuantity).toBe(100n);

    book.cancel(BigInt(result.serverOrderId), 2000);
    // After cancel, both price and quantity should be zero (empty price level is removed)
    expect(book.getBbo().bidPrice).toBe(0n);
    expect(book.getBbo().bidQuantity).toBe(0n);
    expect(book.getBbo().lastUpdateTs).toBe(2000);
  });

  test("BBO falls back to next-best level when best bid is cancelled", () => {
    const book = makeBook();

    helperAdd(book, buy("buy-1", 50n, 100n));
    const r2 = helperAdd(book, buy("buy-2", 55n, 200n));

    // Best bid is 55
    expect(book.getBbo().bidPrice).toBe(55n);
    expect(book.getBbo().bidQuantity).toBe(200n);

    // Cancel the best bid — should fall back to 50
    book.cancel(BigInt(r2.serverOrderId));
    expect(book.getBbo().bidPrice).toBe(50n);
    expect(book.getBbo().bidQuantity).toBe(100n);
  });

  test("BBO falls back to next-best level when best ask is cancelled", () => {
    const book = makeBook();

    const r1 = helperAdd(book, sell("sell-1", 60n, 100n));
    helperAdd(book, sell("sell-2", 65n, 200n));

    // Best ask is 60
    expect(book.getBbo().askPrice).toBe(60n);

    // Cancel the best ask — should fall back to 65
    book.cancel(BigInt(r1.serverOrderId));
    expect(book.getBbo().askPrice).toBe(65n);
    expect(book.getBbo().askQuantity).toBe(200n);
  });

  test("BBO aggregates quantity at same price level", () => {
    const book = makeBook();

    helperAdd(book, buy("buy-1", 50n, 100n));
    helperAdd(book, buy("buy-2", 50n, 150n));

    const bbo = book.getBbo();
    expect(bbo.bidPrice).toBe(50n);
    expect(bbo.bidQuantity).toBe(250n);
  });

  test("BBO updates after cancel reduces quantity at best level", () => {
    const book = makeBook();

    const r1 = helperAdd(book, buy("buy-1", 50n, 100n));
    helperAdd(book, buy("buy-2", 50n, 150n));

    expect(book.getBbo().bidQuantity).toBe(250n);

    // Cancel one order at the best level
    book.cancel(BigInt(r1.serverOrderId));
    expect(book.getBbo().bidPrice).toBe(50n);
    expect(book.getBbo().bidQuantity).toBe(150n);
  });

  test("BBO updates correctly after trade fills best ask level", () => {
    const book = makeBook();

    // Set up asks at two price levels
    helperAdd(book, sell("sell-1", 60n, 50n));
    helperAdd(book, sell("sell-2", 65n, 100n));

    expect(book.getBbo().askPrice).toBe(60n);
    expect(book.getBbo().askQuantity).toBe(50n);

    // Buy order fills the entire best ask level
    helperAdd(book, buy("buy-1", 60n, 50n));

    // Ask should move to next level
    expect(book.getBbo().askPrice).toBe(65n);
    expect(book.getBbo().askQuantity).toBe(100n);
  });

  test("BBO reflects both sides correctly in a two-sided book after trades", () => {
    const book = makeBook();

    helperAdd(book, buy("buy-1", 50n, 100n));
    helperAdd(book, buy("buy-2", 48n, 200n));
    helperAdd(book, sell("sell-1", 55n, 150n));
    helperAdd(book, sell("sell-2", 58n, 300n));

    let bbo = book.getBbo();
    expect(bbo.bidPrice).toBe(50n);
    expect(bbo.askPrice).toBe(55n);

    // Incoming sell crosses the best bid
    helperAdd(book, sell("sell-cross", 50n, 100n));

    bbo = book.getBbo();
    // Best bid filled → falls to 48
    expect(bbo.bidPrice).toBe(48n);
    expect(bbo.bidQuantity).toBe(200n);
    // Asks unchanged
    expect(bbo.askPrice).toBe(55n);
  });
});
