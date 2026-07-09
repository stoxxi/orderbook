// packages/orderbook/__tests__/getOrdersForUser.spec.ts
//
// PR1.2 — OrderBook.getOrdersForUser unit tests.
// Used by the Step 2 sandbox builder to enumerate a single user's
// resting orders on a given book without crossing the global
// UserOrderManager.

import { beforeEach, describe, expect, test } from "bun:test";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side, UserContext } from "../src/types";
import { helperAdd } from "./_helpers";

interface TestUser extends UserContext<string> {
  userId: string;
}

function makeInstrument(): Instrument {
  return createInstrument(
    "TEST",
    2,
    0,
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("0.01", 2),
    toCanonicalDecimal("1000000.00", 2),
  );
}

describe("OrderBook.getOrdersForUser", () => {
  let book: OrderBook<TestUser>;

  beforeEach(() => {
    book = new OrderBook<TestUser>(makeInstrument(), noOpLogger, noOpMetrics);
  });

  test("returns empty array for a user with no orders", () => {
    expect(book.getOrdersForUser("ghost").length).toBe(0);
  });

  test("returns empty array on an empty book", () => {
    expect(book.getOrdersForUser("alice").length).toBe(0);
  });

  test("returns only orders belonging to the requested user", () => {
    helperAdd(
      book,
      Object.assign(new Order("a1", Side.BUY, 10000n, 50n), { userData: { userId: "alice" } }),
    );
    helperAdd(
      book,
      Object.assign(new Order("a2", Side.BUY, 9900n, 30n), { userData: { userId: "alice" } }),
    );
    helperAdd(
      book,
      Object.assign(new Order("b1", Side.SELL, 10100n, 25n), { userData: { userId: "bob" } }),
    );
    helperAdd(
      book,
      Object.assign(new Order("c1", Side.BUY, 9800n, 10n), { userData: { userId: "carol" } }),
    );

    const aliceOrders = book.getOrdersForUser("alice");
    expect(aliceOrders.length).toBe(2);
    expect(aliceOrders.map((o) => o.orderId).sort()).toEqual(["a1", "a2"]);

    const bobOrders = book.getOrdersForUser("bob");
    expect(bobOrders.length).toBe(1);
    expect(bobOrders[0].orderId).toBe("b1");

    const carolOrders = book.getOrdersForUser("carol");
    expect(carolOrders.length).toBe(1);
    expect(carolOrders[0].orderId).toBe("c1");
  });

  test("returns orders from BOTH sides of the book", () => {
    helperAdd(
      book,
      Object.assign(new Order("a-buy", Side.BUY, 9900n, 50n), { userData: { userId: "alice" } }),
    );
    helperAdd(
      book,
      Object.assign(new Order("a-sell", Side.SELL, 10100n, 50n), { userData: { userId: "alice" } }),
    );

    const aliceOrders = book.getOrdersForUser("alice");
    expect(aliceOrders.length).toBe(2);
    expect(aliceOrders.map((o) => o.orderId).sort()).toEqual(["a-buy", "a-sell"]);
  });

  test("skips orders with userData === null", () => {
    helperAdd(book, new Order("anon1", Side.BUY, 9900n, 50n));
    helperAdd(
      book,
      Object.assign(new Order("a1", Side.BUY, 9800n, 30n), { userData: { userId: "alice" } }),
    );

    expect(book.getOrdersForUser("alice").length).toBe(1);
    // Querying with whatever userId never matches null userData.
    expect(book.getOrdersForUser(null).length).toBe(0);
    expect(book.getOrdersForUser(undefined).length).toBe(0);
  });

  test("returns clean arrays — mutating them does not affect the book", () => {
    helperAdd(
      book,
      Object.assign(new Order("a1", Side.BUY, 10000n, 50n), { userData: { userId: "alice" } }),
    );
    const orders1 = book.getOrdersForUser("alice");
    orders1.length = 0;
    const orders2 = book.getOrdersForUser("alice");
    expect(orders2.length).toBe(1);
  });
});
