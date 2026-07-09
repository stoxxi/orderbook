// packages/orderbook/__tests__/clone-property.spec.ts
//
// PR1.1 — OrderBook clone surface property tests
// (docs/architecture/06-step2-engine-atomicity-refactor.md §5.6, §7.1)
//
// Purpose: pin the structural-clone contract for the Step 2 sandbox.
// Every cloned field listed in the §5.6 table must round-trip identically
// AND a sandbox-style "clone, run an op, swap back" sequence must produce
// observably identical state to the live alternative.
//
// What "identical" means here:
//   - exportSnapshot()  — byte-equal serialized representations.
//   - Linked-list pointer integrity holds inside clone (every node's
//     _next._prev references back to itself).
//   - No cross-references between the live and clone object graphs
//     (mutating the clone never reaches into live, and vice versa).
//   - Kline emission — same trade through both books emits byte-equal
//     onCandleClosed events (catches missing 24h/candle state, R4 C1).
//   - BBO emission — same top-of-book change emits matching BBO updates.
//
// Production code paths do NOT yet invoke `OrderBook.clone()`. PR1.1
// ships the clone surface dead-but-tested. PR2 wires it into
// `cloneSymbolLocalState`.

import { describe, expect, test, vi } from "bun:test";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { Bbo } from "../src/depth";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { BboListener, OrderListener, TradeListener } from "../src/listeners";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Candle, Side } from "../src/types";
import { helperAdd, helperSyncAfterImport } from "./_helpers";

/**
 * Stringifies an object including BigInt values (via base-10 string
 * coercion). Used in place of `JSON.stringify` for byte-equality checks
 * on snapshots and BBO buffers, both of which contain `bigint` fields.
 */
function bigintStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

// ─── Fixtures ─────────────────────────────────────────────────────────

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

function makeBook(): OrderBook {
  return new OrderBook(makeInstrument(), noOpLogger, noOpMetrics);
}

function emptyBook(): OrderBook {
  return makeBook();
}

function singleBidBook(): OrderBook {
  const b = makeBook();
  helperAdd(b, new Order("b1", Side.BUY, 10000n, 100n));
  return b;
}

function singleAskBook(): OrderBook {
  const b = makeBook();
  helperAdd(b, new Order("a1", Side.SELL, 10100n, 100n));
  return b;
}

function bothSidesBook(): OrderBook {
  const b = makeBook();
  helperAdd(b, new Order("b1", Side.BUY, 9900n, 50n));
  helperAdd(b, new Order("b2", Side.BUY, 10000n, 75n));
  helperAdd(b, new Order("a1", Side.SELL, 10100n, 100n));
  helperAdd(b, new Order("a2", Side.SELL, 10200n, 25n));
  return b;
}

function deepLadderBook(): OrderBook {
  // 10 bid prices × 3 orders per price (FIFO depth at each level), same for asks.
  const b = makeBook();
  for (let i = 0; i < 10; i++) {
    const price = BigInt(9000 + i * 10);
    for (let q = 0; q < 3; q++) {
      helperAdd(b, new Order(`bid-${i}-${q}`, Side.BUY, price, BigInt(10 + q)));
    }
  }
  for (let i = 0; i < 10; i++) {
    const price = BigInt(10100 + i * 10);
    for (let q = 0; q < 3; q++) {
      helperAdd(b, new Order(`ask-${i}-${q}`, Side.SELL, price, BigInt(10 + q)));
    }
  }
  return b;
}

function ammDrivenBook(): OrderBook {
  // AMM-driven shape: many tightly-packed price levels with single orders
  // per level (mimics a quoter posting one resting order per tick).
  const b = makeBook();
  for (let i = 0; i < 50; i++) {
    helperAdd(b, new Order(`amm-bid-${i}`, Side.BUY, BigInt(9500 + i), 100n));
    helperAdd(b, new Order(`amm-ask-${i}`, Side.SELL, BigInt(10100 + i), 100n));
  }
  return b;
}

function postTradeBook(): OrderBook {
  // A book that's been through a partial-fill match — exercises
  // cumulativeFilledQuantity, lastTradePrice, nextTradeId, currentCandle,
  // volumeBuckets, BBO double-buffer state.
  const b = makeBook();
  helperAdd(b, new Order("rest1", Side.SELL, 10100n, 100n), 1000);
  helperAdd(b, new Order("rest2", Side.SELL, 10200n, 100n), 1500);
  helperAdd(b, new Order("taker", Side.BUY, 10200n, 150n), 2000); // 100 @ 10100, 50 @ 10200
  return b;
}

const fixtures: Array<[string, () => OrderBook]> = [
  ["empty", emptyBook],
  ["single-bid", singleBidBook],
  ["single-ask", singleAskBook],
  ["both-sides", bothSidesBook],
  ["deep-ladder", deepLadderBook],
  ["amm-driven", ammDrivenBook],
  ["post-trade", postTradeBook],
];

// ─── exportSnapshot equivalence ───────────────────────────────────────

describe("OrderBook.clone — snapshot equivalence", () => {
  for (const [name, build] of fixtures) {
    test(`${name}: clone().exportSnapshot() byte-equals live.exportSnapshot()`, () => {
      const live = build();
      const cloned = live.clone();
      const liveSnap = live.exportSnapshot("CLONE-EQ");
      const cloneSnap = cloned.exportSnapshot("CLONE-EQ");
      expect(bigintStringify(cloneSnap)).toBe(bigintStringify(liveSnap));
    });
  }
});

// ─── Linked-list pointer integrity ────────────────────────────────────

describe("OrderBook.clone — linked-list pointer integrity", () => {
  /**
   * Walks every Limit on both sides and verifies, for every order:
   *   - if order has _next, then order._next._prev === order
   *   - if order has _prev, then order._prev._next === order
   *   - order._limit !== null
   *   - order._limit's head/tail correctly bound the queue
   */
  function assertPointerIntegrity(book: OrderBook): void {
    const sides = [book["bids"], book["asks"]] as const;
    for (const side of sides) {
      for (const limit of side.forward()) {
        let cur = limit["head"];
        let count = 0;
        while (cur !== null) {
          // Self-reference check (cyclic pointer guard).
          expect(cur._prev).not.toBe(cur);
          expect(cur._next).not.toBe(cur);
          // Back-pointer must be set to this limit.
          expect(cur._limit).toBe(limit as unknown as typeof cur._limit);
          // Forward integrity.
          if (cur._next !== null) {
            expect(cur._next._prev).toBe(cur);
          }
          // Backward integrity.
          if (cur._prev !== null) {
            expect(cur._prev._next).toBe(cur);
          }
          cur = cur._next;
          count++;
          if (count > 10000) throw new Error("integrity walk overran — possible cycle");
        }
        // Aggregate sanity: count traversed must equal the limit's reported count.
        expect(count).toBe(limit.orderCount);
      }
    }
  }

  for (const [name, build] of fixtures) {
    test(`${name}: clone has self-consistent intrusive linked lists`, () => {
      const cloned = build().clone();
      assertPointerIntegrity(cloned);
    });
  }
});

// ─── No cross-references between live and clone ──────────────────────

describe("OrderBook.clone — no cross-references between live and clone", () => {
  /**
   * Builds the set of every Order reference reachable from `book.bids`,
   * `book.asks`, and `book.orderMap`. Returns a Set for O(1) membership
   * checks.
   */
  function collectOrderRefs(book: OrderBook): Set<unknown> {
    const refs = new Set<unknown>();
    const sides = [book["bids"], book["asks"]] as const;
    for (const side of sides) {
      for (const limit of side.forward()) {
        for (const order of limit) {
          refs.add(order);
        }
      }
    }
    for (const order of book["orderMap"].values()) {
      refs.add(order);
    }
    return refs;
  }

  /**
   * Returns the set of Limit references reachable from `book.bids` and
   * `book.asks`.
   */
  function collectLimitRefs(book: OrderBook): Set<unknown> {
    const refs = new Set<unknown>();
    const sides = [book["bids"], book["asks"]] as const;
    for (const side of sides) {
      for (const limit of side.forward()) {
        refs.add(limit);
      }
    }
    return refs;
  }

  for (const [name, build] of fixtures) {
    test(`${name}: clone shares no Order or Limit references with live`, () => {
      const live = build();
      const cloned = live.clone();

      const liveOrders = collectOrderRefs(live);
      const cloneOrders = collectOrderRefs(cloned);
      for (const ref of cloneOrders) {
        expect(liveOrders.has(ref)).toBe(false);
      }

      const liveLimits = collectLimitRefs(live);
      const cloneLimits = collectLimitRefs(cloned);
      for (const ref of cloneLimits) {
        expect(liveLimits.has(ref)).toBe(false);
      }
    });

    test(`${name}: every clone order's _limit points at a clone Limit (never a live one)`, () => {
      const live = build();
      const cloned = live.clone();
      const liveLimits = collectLimitRefs(live);
      const cloneLimits = collectLimitRefs(cloned);
      for (const order of collectOrderRefs(cloned)) {
        const o = order as Order;
        if (o._limit !== null) {
          expect(liveLimits.has(o._limit)).toBe(false);
          expect(cloneLimits.has(o._limit)).toBe(true);
        }
      }
    });
  }
});

// ─── Independence: mutating one does not affect the other ────────────

describe("OrderBook.clone — mutating one side never affects the other", () => {
  test("adding an order to clone leaves live unchanged", () => {
    const live = bothSidesBook();
    const cloned = live.clone();
    // Sync the test helper's per-book IdGenerator past the SIDs the
    // clone already carries — without this, helperAdd starts a fresh
    // generator at SID 1 and collides with cloned orders. Production
    // code does the equivalent via the engine's sequencer; tests use
    // helperSyncAfterImport for the same effect.
    helperSyncAfterImport(cloned);
    const liveSnapBefore = live.exportSnapshot("INDEP");

    helperAdd(cloned, new Order("clone-only", Side.BUY, 9800n, 30n));

    const liveSnapAfter = live.exportSnapshot("INDEP");
    expect(bigintStringify(liveSnapBefore)).toBe(bigintStringify(liveSnapAfter));
  });

  test("adding an order to live leaves clone unchanged", () => {
    const live = bothSidesBook();
    const cloned = live.clone();
    const cloneSnapBefore = cloned.exportSnapshot("INDEP");

    helperAdd(live, new Order("live-only", Side.SELL, 10500n, 40n));

    const cloneSnapAfter = cloned.exportSnapshot("INDEP");
    expect(bigintStringify(cloneSnapBefore)).toBe(bigintStringify(cloneSnapAfter));
  });

  test("matching trades on clone does not mutate live nextTradeId or lastTradePrice", () => {
    const live = bothSidesBook();
    const cloned = live.clone();
    helperSyncAfterImport(cloned);
    const liveNextTradeIdBefore = live["nextTradeId"];
    const liveLastTradePriceBefore = live["lastTradePrice"];

    // Cross the spread on the clone.
    helperAdd(cloned, new Order("clone-cross", Side.BUY, 10100n, 100n));

    expect(live["nextTradeId"]).toBe(liveNextTradeIdBefore);
    expect(live["lastTradePrice"]).toBe(liveLastTradePriceBefore);
  });
});

// ─── Kline equivalence (R4 C1: catches missing 24h/candle state) ────

describe("OrderBook.clone — kline equivalence across candle boundary", () => {
  test("same trade sequence on live and clone emits matching onCandleClosed events", () => {
    // Setup: pre-load identical resting state, then apply the SAME trade
    // sequence to both books. The candle engine emits onCandleClosed when
    // a trade arrives in a logical-minute later than `currentCandle`.
    // If clone is missing currentCandle / volumeBuckets / lastUpdateHour,
    // the close events diverge.
    const liveCandles: Candle[] = [];
    const cloneCandles: Candle[] = [];

    const liveTrade: TradeListener = {
      onTrade: vi.fn(),
      onCandleClosed: (_book, c) => liveCandles.push({ ...c }),
    };
    const cloneTrade: TradeListener = {
      onTrade: vi.fn(),
      onCandleClosed: (_book, c) => cloneCandles.push({ ...c }),
    };

    // Build a live book and run a trade WITHIN minute 0 to seed
    // currentCandle, lastUpdateHour, and volumeBuckets.
    const live = makeBook();
    helperAdd(live, new Order("rest1", Side.SELL, 10100n, 100n), 1000); // ts=1000ms
    helperAdd(live, new Order("rest2", Side.SELL, 10200n, 100n), 1500);
    helperAdd(live, new Order("taker", Side.BUY, 10200n, 50n), 2000); // matches @ 10100

    // Clone NOW — must carry currentCandle, lastTradePrice, volume buckets, etc.
    const cloned = live.clone();
    helperSyncAfterImport(cloned);

    live.setTradeListener(liveTrade);
    cloned.setTradeListener(cloneTrade);

    // Cross a candle boundary on BOTH books with identical logical
    // timestamps (>60s after the seeding trade). This forces
    // onCandleClosed for the seeded candle on each.
    helperAdd(live, new Order("late-rest", Side.SELL, 10300n, 100n), 65000);
    helperAdd(live, new Order("late-taker", Side.BUY, 10300n, 25n), 65500);

    helperAdd(cloned, new Order("late-rest", Side.SELL, 10300n, 100n), 65000);
    helperAdd(cloned, new Order("late-taker", Side.BUY, 10300n, 25n), 65500);

    // Both should have emitted exactly one closed candle for the seeded
    // bucket, with byte-equal OHLCV.
    expect(cloneCandles.length).toBe(liveCandles.length);
    expect(cloneCandles.length).toBeGreaterThan(0);
    for (let i = 0; i < liveCandles.length; i++) {
      expect(bigintStringify(cloneCandles[i])).toBe(bigintStringify(liveCandles[i]));
    }
  });
});

// ─── BBO equivalence ─────────────────────────────────────────────────

describe("OrderBook.clone — BBO equivalence across top-of-book changes", () => {
  test("same operation on live and clone emits matching BBO updates", () => {
    const liveBbos: Bbo[] = [];
    const cloneBbos: Bbo[] = [];

    const live = bothSidesBook();
    const cloned = live.clone();
    helperSyncAfterImport(cloned);

    const liveBboL: BboListener = {
      onBboChange: (_b, bbo) => liveBbos.push({ ...bbo }),
    };
    const cloneBboL: BboListener = {
      onBboChange: (_b, bbo) => cloneBbos.push({ ...bbo }),
    };
    live.setBboListener(liveBboL);
    cloned.setBboListener(cloneBboL);

    // Identical top-of-book change on both: improve the bid.
    helperAdd(live, new Order("better-bid", Side.BUY, 10050n, 200n), 5000);
    helperAdd(cloned, new Order("better-bid", Side.BUY, 10050n, 200n), 5000);

    expect(cloneBbos.length).toBe(liveBbos.length);
    expect(cloneBbos.length).toBeGreaterThan(0);
    // Compare each emitted BBO struct (bidPrice, bidQuantity, askPrice, askQuantity).
    for (let i = 0; i < liveBbos.length; i++) {
      expect(cloneBbos[i].bidPrice).toBe(liveBbos[i].bidPrice);
      expect(cloneBbos[i].bidQuantity).toBe(liveBbos[i].bidQuantity);
      expect(cloneBbos[i].askPrice).toBe(liveBbos[i].askPrice);
      expect(cloneBbos[i].askQuantity).toBe(liveBbos[i].askQuantity);
    }
  });

  test("clone's BBO double-buffer state is preserved (bboIndex, bboLastUpdateTs)", () => {
    const live = postTradeBook();
    const cloned = live.clone();
    expect(cloned["bboIndex"]).toBe(live["bboIndex"]);
    expect(cloned["bboLastUpdateTs"]).toBe(live["bboLastUpdateTs"]);
    // Both readable buffers must hold the same BBO snapshot.
    expect(bigintStringify(cloned["bboBuffers"][cloned["bboIndex"]])).toBe(
      bigintStringify(live["bboBuffers"][live["bboIndex"]]),
    );
  });
});

// ─── Listeners reset on the clone ────────────────────────────────────

describe("OrderBook.clone — listeners reset to null", () => {
  test("clone has no order/trade/bbo/depth listeners attached", () => {
    const live = makeBook();
    live.setOrderListener({
      onAccept: vi.fn(),
      onReject: vi.fn(),
      onFill: vi.fn(),
      onCancel: vi.fn(),
      onCancelReject: vi.fn(),
      onReplace: vi.fn(),
      onReplaceReject: vi.fn(),
    } as OrderListener);
    live.setTradeListener({ onTrade: vi.fn() });
    live.setBboListener({ onBboChange: vi.fn() });
    live.setDepthListener({ onDepthChange: vi.fn() });

    const cloned = live.clone();
    expect(cloned["orderListener"]).toBeNull();
    expect(cloned["tradeListener"]).toBeNull();
    expect(cloned["bboListener"]).toBeNull();
    expect(cloned["depthListener"]).toBeNull();
  });
});

// ─── 24h rolling stats preserved ─────────────────────────────────────

describe("OrderBook.clone — rolling 24h stats arrays are independent copies", () => {
  test("clone's volumeBuckets and tradeCountBuckets equal live's by value, not by reference", () => {
    const live = postTradeBook();
    const cloned = live.clone();
    expect(cloned["volumeBuckets"]).toEqual(live["volumeBuckets"]);
    expect(cloned["tradeCountBuckets"]).toEqual(live["tradeCountBuckets"]);
    expect(cloned["volumeBuckets"]).not.toBe(live["volumeBuckets"]);
    expect(cloned["tradeCountBuckets"]).not.toBe(live["tradeCountBuckets"]);

    // Mutating one must not affect the other.
    cloned["volumeBuckets"][0] += 999n;
    expect(live["volumeBuckets"][0]).not.toBe(cloned["volumeBuckets"][0]);
  });

  test("clone's currentCandle is a value copy of live's, not the same reference", () => {
    const live = postTradeBook();
    const cloned = live.clone();
    if (live["currentCandle"] !== null) {
      expect(cloned["currentCandle"]).toEqual(live["currentCandle"]);
      expect(cloned["currentCandle"]).not.toBe(live["currentCandle"]);
    } else {
      expect(cloned["currentCandle"]).toBeNull();
    }
  });
});

// ─── Depth dirty tracking preserved ──────────────────────────────────

describe("OrderBook.clone — depth dirty sets are independent copies", () => {
  test("clone's dirtyBids and dirtyAsks equal live's by value, not by reference", () => {
    const live = bothSidesBook();
    // Trigger a state change that populates dirty sets, but DON'T flush.
    helperAdd(live, new Order("dirty-bid", Side.BUY, 9800n, 10n));

    const cloned = live.clone();
    expect([...cloned["dirtyBids"]]).toEqual([...live["dirtyBids"]]);
    expect([...cloned["dirtyAsks"]]).toEqual([...live["dirtyAsks"]]);
    expect(cloned["dirtyBids"]).not.toBe(live["dirtyBids"]);
    expect(cloned["dirtyAsks"]).not.toBe(live["dirtyAsks"]);
  });
});

// ─── Transient state reset ───────────────────────────────────────────

describe("OrderBook.clone — transient state is reset on the clone", () => {
  test("clone's deferredCallbacks, _currentFills are empty; isProcessing is false", () => {
    const cloned = postTradeBook().clone();
    expect(cloned["deferredCallbacks"].length).toBe(0);
    expect(cloned["_currentFills"].length).toBe(0);
    expect(cloned["isProcessing"]).toBe(false);
  });
});

// ─── M2 — Composite §5.6 field-table walk (drift detection) ──────────
//
// The behavioral tests above prove correctness indirectly: snapshot
// equivalence covers bids/asks/orderMap/etc., kline equivalence covers
// candle/buckets, BBO equivalence covers bbo*, and so on. This composite
// test explicitly walks every field listed in §5.6 of the architecture
// doc, asserting deep-equality + reference-independence in one place.
//
// Stop-and-ask precedent: if a future contributor adds a field to
// OrderBook and forgets to clone it, this test fails AT THE FIELD LEVEL,
// naming the missing field — much faster to debug than the downstream
// behavioral drift the existing tests would surface.
//
// The FIELDS array MUST stay in sync with the doc table. If they drift,
// escalate (don't silently update) — the table is the contract.

describe("OrderBook.clone — composite §5.6 field-table walk (M2)", () => {
  // Fields per docs/architecture/06-step2-engine-atomicity-refactor.md §5.6
  // (the "Required clone targets" table). 19 entries, locked.
  const FIELDS = [
    "bids",
    "asks",
    "orderMap",
    "nextTradeId",
    "depth",
    "bboBuffers",
    "bboIndex",
    "bboLastUpdateTs",
    "bboIsDirty",
    "depthIsDirty",
    "depthSeq",
    "dirtyBids",
    "dirtyAsks",
    "volumeBuckets",
    "tradeCountBuckets",
    "lastUpdateHour",
    "lastTradePrice",
    "currentCandle",
    "currentLogicalTs",
  ] as const;

  test("FIELDS array length matches §5.6 table (drift sentinel)", () => {
    // The doc lists 19 fields. If this assertion fails, either the doc
    // changed (escalate) or this list drifted (fix here).
    expect(FIELDS.length).toBe(19);
  });

  test("every §5.6 field deep-equals between live and clone (post-trade fixture)", () => {
    const live = postTradeBook();
    const cloned = live.clone();

    for (const field of FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveValue = (live as any)[field];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cloneValue = (cloned as any)[field];
      // toEqual() does deep equality; the inline message names the
      // field so a regression points straight at the missing entry.
      expect(cloneValue, `field "${field}" diverged between live and clone`).toEqual(liveValue);
    }
  });

  test("every §5.6 mutable container is a distinct reference (no shared state)", () => {
    // Fields whose runtime value is a mutable container — clone must
    // copy them, not share the live reference. Primitives are excluded
    // (they're values, not references).
    const MUTABLE_CONTAINERS = [
      "bids",
      "asks",
      "orderMap",
      "depth",
      "bboBuffers",
      "dirtyBids",
      "dirtyAsks",
      "volumeBuckets",
      "tradeCountBuckets",
      // currentCandle: only when non-null (POJO clone via spread)
    ] as const;

    const live = postTradeBook();
    const cloned = live.clone();

    for (const field of MUTABLE_CONTAINERS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveRef = (live as any)[field];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cloneRef = (cloned as any)[field];
      expect(cloneRef, `field "${field}" must be a distinct reference on the clone`).not.toBe(
        liveRef,
      );
    }

    // currentCandle when non-null: separate reference.
    const liveCandle = live["currentCandle"];
    const cloneCandle = cloned["currentCandle"];
    if (liveCandle !== null) {
      expect(cloneCandle).not.toBe(liveCandle);
    }
  });
});
