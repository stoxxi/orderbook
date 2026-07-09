// packages/orderbook/__tests__/listener-isolation.spec.ts
//
// Regression suite: a misbehaving market-data listener (onCandleClosed /
// onBboChange / onDepthChange) MUST NOT be able to abort an in-flight
// add/cancel/replace or corrupt book state.
//
// Root cause (pre-fix): these three listeners were dispatched RAW — a plain
// synchronous call inside the match/notification path — unlike order/trade
// listeners which go through deferCallback + safeInvokeCallback. A throwing
// listener propagated out of the operation; a reentrant one tripped
// guardReentrancy → OrderBookError → caught by add()'s catch → an already-rested
// order was mislabeled REJECTED while still linked in the book (a zombie that
// cancel() refuses but the match loop still fills).
//
// Fix: onCandleClosed is now deferred+guarded like every other listener; BBO and
// depth are guarded synchronously (their contracts require synchronous
// consumption of the double-buffer / clone, so they cannot be deferred).

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

describe("listener isolation: onCandleClosed", () => {
  test("a throwing candle listener does not abort matching; taker rests cleanly and is cancellable", () => {
    const book = OrderBook.create("CANDLE");
    book.setTradeListener({
      onTrade: () => {},
      onCandleClosed: () => { throw new Error("candle listener bomb"); },
    });

    // Open a candle in minute 0.
    helperAdd(book, new Order("m1", Side.SELL, 10000n, 10n), 0);
    helperAdd(book, new Order("t1", Side.BUY, 10000n, 10n), 0);

    // Two makers; a taker in minute 1 crosses the boundary on its first fill,
    // closing the candle → listener throws.
    helperAdd(book, new Order("m2", Side.SELL, 10000n, 10n), 1_000);
    helperAdd(book, new Order("m3", Side.SELL, 10100n, 10n), 2_000);

    const taker = new Order("tk", Side.BUY, 10100n, 30n);
    expect(() => helperAdd(book, taker, 61_000)).not.toThrow();

    // Matching completed: both makers filled, residual (10) rests.
    expect(taker.cumulativeFilledQuantity).toBe(20n);
    expect(taker.openQuantity).toBe(10n);
    expect(taker.state).toBe(OrderState.PARTIALLY_FILLED);
    expect(taker._limit).not.toBeNull();

    // Not a zombie — the resting residual cancels cleanly.
    const sid = taker.serverOrderId!;
    expect(() => book.cancel(sid)).not.toThrow();
    expect(book.getOrder(sid)).toBeUndefined();
    expect(() => (book as any).assertPostReplayInvariants()).not.toThrow();
  });

  test("candle listener still fires (deferred) on the happy path", () => {
    const book = OrderBook.create("CANDLE2");
    const closed: number[] = [];
    book.setTradeListener({
      onTrade: () => {},
      onCandleClosed: (_b, c) => { closed.push(c.startMinute); },
    });
    helperAdd(book, new Order("m1", Side.SELL, 10000n, 10n), 0);
    helperAdd(book, new Order("t1", Side.BUY, 10000n, 10n), 0);     // opens candle @minute 0
    helperAdd(book, new Order("m2", Side.SELL, 10000n, 10n), 61_000);
    helperAdd(book, new Order("t2", Side.BUY, 10000n, 10n), 61_000); // crosses → closes minute-0 candle
    expect(closed).toEqual([0]);
  });
});

describe("listener isolation: onBboChange", () => {
  test("a throwing BBO listener does not abort add(); order rests and is cancellable", () => {
    const book = OrderBook.create("BBO");
    book.setBboListener({ onBboChange: () => { throw new Error("bbo listener bomb"); } });

    const o = new Order("rest", Side.BUY, 10000n, 100n);
    expect(() => helperAdd(book, o)).not.toThrow();
    expect(o.state).toBe(OrderState.NEW);          // NOT mislabeled REJECTED
    const sid = o.serverOrderId!;
    expect(book.getOrder(sid)).toBeDefined();
    expect(() => book.cancel(sid)).not.toThrow();   // cancellable — not a zombie
  });

  test("a reentrant BBO listener cannot mislabel a rested order or create matchable zombie liquidity", () => {
    const book = OrderBook.create("BBO2");
    let fired = 0;
    book.setBboListener({
      onBboChange: (b) => {
        fired++;
        if (fired === 1) b.cancel(999n); // illegal reentrancy — must be swallowed, not corrupt state
      },
    });

    const o = new Order("rest", Side.BUY, 10000n, 100n);
    expect(() => helperAdd(book, o)).not.toThrow();
    expect(o.state).toBe(OrderState.NEW);           // rested, not REJECTED
    expect(o._limit).not.toBeNull();

    // The order is genuinely live: a counter-order matches it as normal liquidity,
    // and it is cancellable — no REJECTED-but-matchable contradiction.
    const sid = o.serverOrderId!;
    expect(book.getOrder(sid)).toBeDefined();
    expect(() => (book as any).assertPostReplayInvariants()).not.toThrow();
    book.cancel(sid);
    expect(book.getOrder(sid)).toBeUndefined();
  });

  test("BBO listener still fires with valid top-of-book on the happy path", () => {
    const book = OrderBook.create("BBO3");
    const seen: bigint[] = [];
    book.setBboListener({ onBboChange: (_b, bbo) => { seen.push(bbo.bidPrice); } });
    helperAdd(book, new Order("b", Side.BUY, 10000n, 5n));
    expect(seen).toContain(10000n);
  });
});

describe("listener isolation: onDepthChange", () => {
  test("a throwing depth listener does not abort add(); order rests and is cancellable", () => {
    const book = OrderBook.create("DEPTH");
    book.setDepthListener({ onDepthChange: () => { throw new Error("depth listener bomb"); } });

    const o = new Order("rest", Side.BUY, 10000n, 100n);
    expect(() => helperAdd(book, o)).not.toThrow();
    expect(o.state).toBe(OrderState.NEW);
    const sid = o.serverOrderId!;
    expect(() => book.cancel(sid)).not.toThrow();
    expect(() => (book as any).assertPostReplayInvariants()).not.toThrow();
  });

  test("depth listener still fires with the new level on the happy path", () => {
    const book = OrderBook.create("DEPTH2");
    let levels = 0;
    book.setDepthListener({ onDepthChange: (_b, d) => { levels = d.bids.length; } });
    helperAdd(book, new Order("b", Side.BUY, 10000n, 5n));
    expect(levels).toBe(1);
  });
});
