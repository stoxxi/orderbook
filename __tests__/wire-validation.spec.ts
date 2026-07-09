// packages/orderbook/__tests__/wire-validation.spec.ts
//
// wireToTradeSnapshot now validates untrusted string fields (previously parseInt
// silently accepted "12abc"->12 and NaN on garbage). These lock the guards.

import { describe, expect, test } from "bun:test";
import { wireToTradeSnapshot, tradeSnapshotToWire } from "../src/wire";

const good = {
  matchPrice: "1000",
  matchQuantity: "5",
  makingOrderId: "m1",
  takingOrderId: "t1",
  tradeId: "42",
};

describe("wireToTradeSnapshot validation", () => {
  test("parses a valid wire record", () => {
    const s = wireToTradeSnapshot(good);
    expect(s.matchPrice).toBe(1000n);
    expect(s.matchQuantity).toBe(5n);
    expect(s.tradeId).toBe(42);
  });

  test("rejects a non-integer tradeId (parseInt would have silently truncated)", () => {
    expect(() => wireToTradeSnapshot({ ...good, tradeId: "12abc" })).toThrow(/invalid tradeId/);
  });

  test("rejects an empty tradeId (parseInt would have produced NaN)", () => {
    expect(() => wireToTradeSnapshot({ ...good, tradeId: "" })).toThrow(/invalid tradeId/);
  });

  test("rejects a tradeId beyond MAX_SAFE_INTEGER", () => {
    expect(() => wireToTradeSnapshot({ ...good, tradeId: "9007199254740993" })).toThrow(
      /MAX_SAFE_INTEGER/,
    );
  });

  test("rejects non-numeric price/quantity", () => {
    expect(() => wireToTradeSnapshot({ ...good, matchPrice: "nope" })).toThrow();
    expect(() => wireToTradeSnapshot({ ...good, matchQuantity: "1.5" })).toThrow();
  });

  test("rejects negative price/quantity", () => {
    expect(() => wireToTradeSnapshot({ ...good, matchPrice: "-1" })).toThrow(/negative/);
    expect(() => wireToTradeSnapshot({ ...good, matchQuantity: "-5" })).toThrow(/negative/);
  });

  test("round-trips a valid snapshot", () => {
    expect(wireToTradeSnapshot(tradeSnapshotToWire(wireToTradeSnapshot(good)))).toEqual(
      wireToTradeSnapshot(good),
    );
  });
});
