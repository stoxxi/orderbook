// packages/orderbook/__tests__/logical-timestamp-determinism.spec.ts
//
// add/cancel/replace previously defaulted logicalTimestamp to Date.now(). That
// wall-clock value flowed into currentLogicalTs → exportSnapshot().timestamp,
// candle startMinute, and 24h bucket indices — so a caller that omitted the
// argument silently injected non-deterministic state (a WAL-replay divergence
// footgun; the exchange's cancelAllOrdersForUser is one prod path that omits
// it). The default is now a deterministic fallback: reuse the LAST logical
// timestamp, never wall-clock.

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side, type Price, type Quantity } from "../src/types";

describe("logical-timestamp determinism (no Date.now leak)", () => {
  test("omitting the timestamp yields identical state across wall-clock time", async () => {
    const run = () => {
      const b = OrderBook.create("DET");
      helperAdd(b, new Order("m", Side.SELL, 10000n, 5n)); // no explicit ts
      helperAdd(b, new Order("t", Side.BUY, 10000n, 5n));  // no explicit ts
      return b.exportSnapshot("DET");
    };
    const s1 = run();
    await new Promise((r) => setTimeout(r, 5)); // a "replay" a few ms later
    const s2 = run();
    // Byte-identical: no wall-clock reached the book state.
    expect(s2).toEqual(s1);
    // The deterministic fallback never advances past the initial logical time.
    expect(s2.timestamp).toBe(0);
  });

  test("an explicit timestamp is still honored and reused as the fallback", () => {
    const b = OrderBook.create("DET2");
    helperAdd(b, new Order("m", Side.SELL, 10000n, 5n), 42_000); // explicit
    // Subsequent op with no ts reuses 42_000 (the last logical time), not 0/now.
    b.cancel(1n);
    expect(b.exportSnapshot("DET2").timestamp).toBe(42_000);
  });

  test("cancel/replace with no timestamp do not regress currentLogicalTs to wall-clock", () => {
    const b = OrderBook.create("DET3");
    helperAdd(b, new Order("a", Side.BUY, 10000n, 5n), 1000);
    helperAdd(b, new Order("b", Side.BUY, 9900n, 5n), 2000);
    b.replace(1n, 3n as Quantity, 10000n as Price); // no ts → reuses 2000
    b.cancel(2n);                                    // no ts → reuses 2000
    expect(b.exportSnapshot("DET3").timestamp).toBe(2000);
  });
});
