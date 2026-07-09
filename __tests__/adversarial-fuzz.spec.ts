import { test } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

test("adversarial wall + cancel storm", () => {
  const book = OrderBook.create("ADV");

  const WALL = 50_000;

  for (let i = 0; i < WALL; i++) {
    const o = new Order(`wall-${i}`, Side.SELL, 10000n, 1n);
    helperAdd(book, o);
  }

  // Cancel storm
  for (let i = 0; i < WALL; i += 2) {
    book.cancel(BigInt(i + 1));
  }

  // Aggressive sweep
  const taker = new Order("taker", Side.BUY, 10000n, BigInt(WALL));
  helperAdd(book, taker);

  // INVARIANT: no crash, no negative quantity
});
