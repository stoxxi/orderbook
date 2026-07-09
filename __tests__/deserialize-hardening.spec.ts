// packages/orderbook/__tests__/deserialize-hardening.spec.ts
//
// Security-audit regressions (Opus 4.8 pre-publish audit, 2026-07-08). Every
// test here is a probe for a missing bound at the snapshot/wire DESERIALIZE
// trust boundary — attacker-reachable because snapshots/WAL/wire records may
// transit disk or network before reaching this pure-matching package.
//
//   P1  unbounded digit-string -> BigInt() stalls the single-threaded venue
//   P2  importSnapshot bounds orderQuantity but not openQuantity
//   P2  wireToTradeSnapshot has no magnitude ceiling on matchPrice/matchQuantity
//   P3  STP debug log emits both users' full userData

import { describe, expect, test } from "bun:test";
import { OrderBook, UserSTPPolicy } from "../src/orderBook";
import { deserializeOrder, Order, OrderState, type SerializedOrder } from "../src/order";
import { wireToTradeSnapshot, type WireTradeSnapshot } from "../src/wire";
import { MAX_QUANTITY_VALUE } from "../src/constants";
import { IdGenerator } from "../src/idGenerator";
import { Side } from "../src/types";
import type { ILogger, LogContext } from "../src/logging";

// A well-formed serialized order we can perturb one field at a time.
function goodOrder(overrides: Partial<SerializedOrder> = {}): SerializedOrder {
  return {
    schemaVersion: 1,
    orderId: "o1",
    serverOrderId: "1",
    side: Side.BUY,
    price: "1000",
    orderQuantity: "5",
    openQuantity: "5",
    state: OrderState.NEW,
    userData: null,
    isProtectedMarket: false,
    ...overrides,
  };
}

function goodWire(overrides: Partial<WireTradeSnapshot> = {}): WireTradeSnapshot {
  return {
    matchPrice: "1000",
    matchQuantity: "5",
    makingOrderId: "m1",
    takingOrderId: "t1",
    tradeId: "42",
    ...overrides,
  };
}

// A digit string long enough to be a real parse-stall but short enough to keep
// the test itself fast (~1ms of BigInt work if the bound is MISSING).
const HUGE_DIGITS = "9".repeat(50_000);

describe("P1 — length cap before BigInt() at the deserialize boundary", () => {
  test("deserializeOrder rejects an over-long price string (does not parse it)", () => {
    expect(() => deserializeOrder(goodOrder({ price: HUGE_DIGITS }))).toThrow();
  });

  test("deserializeOrder rejects an over-long openQuantity string", () => {
    expect(() => deserializeOrder(goodOrder({ openQuantity: HUGE_DIGITS }))).toThrow();
  });

  test("deserializeOrder rejects an over-long cumulativeQuoteValue string", () => {
    // No post-parse range check guards this field — the length cap is its only bound.
    expect(() => deserializeOrder(goodOrder({ cumulativeQuoteValue: HUGE_DIGITS }))).toThrow();
  });

  test("wireToTradeSnapshot rejects an over-long matchPrice string", () => {
    expect(() => wireToTradeSnapshot(goodWire({ matchPrice: HUGE_DIGITS }))).toThrow();
  });

  test("importSnapshot rejects an over-long lastTradePrice string", () => {
    const book = OrderBook.create("DOS", { pricePrecision: 2, quantityPrecision: 0, tickSize: "0.01" });
    expect(() =>
      book.importSnapshot({
        schemaVersion: 1,
        symbol: "DOS",
        timestamp: 0,
        nextTradeId: 1,
        lastTradePrice: HUGE_DIGITS,
        orders: [],
      }),
    ).toThrow();
  });

  test("legitimate large values still parse (cap is generous — no functional regression)", () => {
    // cumulativeQuoteValue = Σ(price×qty) can legitimately reach ~37 digits.
    const legit = "1".repeat(37);
    const o = deserializeOrder(goodOrder({ cumulativeQuoteValue: legit }));
    expect(o.cumulativeQuoteValue).toBe(BigInt(legit));
  });
});

describe("P2 — importSnapshot must bound openQuantity, not only orderQuantity", () => {
  const base = (orders: SerializedOrder[]) => ({
    schemaVersion: 1,
    symbol: "OQ",
    timestamp: 0,
    nextTradeId: 1,
    lastTradePrice: null,
    orders,
  });

  test("rejects openQuantity above the system maximum", () => {
    const book = OrderBook.create("OQ", { pricePrecision: 2, quantityPrecision: 0, tickSize: "0.01" });
    const over = (MAX_QUANTITY_VALUE + 1n).toString();
    // orderQuantity is left huge-but-equal so the EXISTING orderQuantity ceiling
    // also trips; the point is openQuantity must be independently bounded.
    expect(() =>
      book.importSnapshot(base([goodOrder({ orderQuantity: over, openQuantity: over })])),
    ).toThrow();
  });

  test("rejects openQuantity greater than orderQuantity (invariant openQty ≤ orderQty)", () => {
    const book = OrderBook.create("OQ", { pricePrecision: 2, quantityPrecision: 0, tickSize: "0.01" });
    // orderQuantity passes every existing check; openQuantity alone is corrupt.
    expect(() =>
      book.importSnapshot(base([goodOrder({ orderQuantity: "10", openQuantity: "1000000" })])),
    ).toThrow();
  });

  test("rejects cumulativeFilledQuantity greater than orderQuantity (can't fill more than ordered)", () => {
    const book = OrderBook.create("OQ", { pricePrecision: 2, quantityPrecision: 0, tickSize: "0.01" });
    // Every other field is valid; cumulativeFilledQuantity alone is nonsensical
    // (filled 1000 of a 10-lot). The live fill path maintains cumFilled ≤ orderQty.
    expect(() =>
      book.importSnapshot(
        base([goodOrder({ orderQuantity: "10", openQuantity: "10", cumulativeFilledQuantity: "1000" })]),
      ),
    ).toThrow();
  });

  test("accepts a legitimate partially-filled order (cumFilled < orderQty)", () => {
    const book = OrderBook.create("OQ", { pricePrecision: 2, quantityPrecision: 0, tickSize: "0.01" });
    // orderQty 10, 6 filled, 4 resting — the normal partial-fill snapshot shape.
    expect(() =>
      book.importSnapshot(
        base([goodOrder({ orderQuantity: "10", openQuantity: "4", cumulativeFilledQuantity: "6" })]),
      ),
    ).not.toThrow();
  });
});

describe("P2 — wireToTradeSnapshot magnitude ceiling", () => {
  test("rejects matchPrice above the system maximum", () => {
    const over = (MAX_QUANTITY_VALUE + 1n).toString(); // in-length, over-magnitude
    expect(() => wireToTradeSnapshot(goodWire({ matchPrice: over }))).toThrow();
  });

  test("rejects matchQuantity above the system maximum", () => {
    const over = (MAX_QUANTITY_VALUE + 1n).toString();
    expect(() => wireToTradeSnapshot(goodWire({ matchQuantity: over }))).toThrow();
  });
});

describe("P3 — STP debug log must not emit full userData (cross-user PII in logs)", () => {
  // Capture every debug() context object the book emits.
  function capturingLogger(sink: LogContext[]): ILogger {
    const self: ILogger = {
      debug: (_m, c) => c && sink.push(c),
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      withContext: () => self,
    };
    return self;
  }

  test("self-trade-prevented log carries only userId, not the whole userData object", () => {
    const contexts: LogContext[] = [];
    type UD = { userId: string; email: string };
    const book = new OrderBook<UD>(
      OrderBook.create<UD>("STP", { pricePrecision: 2, quantityPrecision: 0, tickSize: "0.01" }).getInstrument(),
      capturingLogger(contexts),
      undefined,
      new UserSTPPolicy<UD>(),
    );
    const idGen = new IdGenerator();

    const maker = new Order<UD>("mk", Side.SELL, 1000n, 5n, { userId: "u1", email: "secret@alice.test" });
    maker.serverOrderId = idGen.next();
    book.add(maker, 1);

    const taker = new Order<UD>("tk", Side.BUY, 1000n, 5n, { userId: "u1", email: "secret@alice.test" });
    taker.serverOrderId = idGen.next();
    book.add(taker, 2); // same user → STP cancels the maker and logs

    const stpLog = contexts.find(
      (c) => "makerUserId" in c || "takerUserId" in c,
    );
    expect(stpLog).toBeDefined();
    // The email (PII) must never appear in the serialized log context.
    expect(JSON.stringify(stpLog)).not.toContain("secret@alice.test");
  });
});
