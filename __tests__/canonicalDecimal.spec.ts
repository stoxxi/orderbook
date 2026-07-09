// packages/orderbook/__tests__/canonicalDecimal.spec.ts

import { describe, expect, test } from "bun:test";

import { parseToInternal } from "../src/instrument";

describe("CanonicalDecimalString enforcement", () => {
  test.each([
    "01",
    "007.50",
    "00.01",
    "1e-8",
    "",
    " ",
    "1.0000", // precision mismatch
  ])("rejects invalid: %s", (v) => {
    expect(() => parseToInternal(v as any, 2, "test")).toThrow();
  });

  test.each([
    ["0.01", 2, 1n],
    ["1.50", 2, 150n],
    ["0.00000001", 8, 1n],
  ])("accepts valid %s", (v, p, out) => {
    expect(parseToInternal(v as any, p)).toBe(out);
  });
});
