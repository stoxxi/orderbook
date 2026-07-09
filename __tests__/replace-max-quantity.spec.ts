import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";
import { MAX_QUANTITY_VALUE } from "../src/constants";

// P1-1 (REVIEW-20260707-FABLE5.md): `add()` rejects orderQuantity > MAX_QUANTITY_VALUE
// (a range invariant + BigInt limb-growth guard), but `validateReplace` had no such
// ceiling — `replace()` was a back door to rest an order at a quantity the engine
// elsewhere declares impossible. These tests lock the two mutators to the same bound.
describe("replace() enforces the same MAX_QUANTITY_VALUE ceiling as add()", () => {
  test("add() rejects an over-max quantity", () => {
    const book = OrderBook.create("T");
    const o = new Order("a", Side.BUY, 10000n, MAX_QUANTITY_VALUE + 1n);
    expect(() => helperAdd(book, o)).toThrow();
  });

  test("replace() rejects an over-max quantity (accepted before the P1-1 fix)", () => {
    const book = OrderBook.create("T");
    const o = new Order("a", Side.BUY, 10000n, 10n);
    helperAdd(book, o);
    expect(() => book.replace(o.serverOrderId!, MAX_QUANTITY_VALUE + 1000n, 10000n)).toThrow();
  });

  test("replace() still accepts a valid in-range quantity", () => {
    const book = OrderBook.create("T");
    const o = new Order("a", Side.BUY, 10000n, 10n);
    helperAdd(book, o);
    expect(() => book.replace(o.serverOrderId!, 500n, 10000n)).not.toThrow();
  });
});
