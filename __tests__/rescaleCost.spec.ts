// packages/orderbook/__tests__/rescaleCost.spec.ts
// Unit tests for rescaleCost — the precision bridge utility

import { describe, expect, it } from "bun:test";
import { MAX_SYSTEM_VAL } from "../src/constants";
import { rescaleCost } from "../src/math";
import type { Cost } from "../src/types";

describe("rescaleCost", () => {
  describe("identity (same precision)", () => {
    it("returns cost unchanged when fromPrecision === toPrecision", () => {
      expect(rescaleCost(12345n as Cost, 3, 3)).toBe(12345n);
    });

    it("handles zero cost at same precision", () => {
      expect(rescaleCost(0n as Cost, 8, 8)).toBe(0n);
    });
  });

  describe("upscaling (toPrecision > fromPrecision)", () => {
    it("scales 3 → 8 correctly (×10^5)", () => {
      // 28.300 (pricePrecision 3) → 28.30000000 (AMMO precision 8)
      // 28300n × 10^5 = 2_830_000_000n
      const result = rescaleCost(28300n as Cost, 3, 8);
      expect(result).toBe(2_830_000_000n);
    });

    it("scales 2 → 8 correctly (×10^6)", () => {
      // 100.00 (precision 2) → 100.00000000 (precision 8)
      // 10000n × 10^6 = 10_000_000_000n
      const result = rescaleCost(10000n as Cost, 2, 8);
      expect(result).toBe(10_000_000_000n);
    });

    it("is exact — no rounding on upscale", () => {
      const result = rescaleCost(1n as Cost, 0, 8);
      expect(result).toBe(100_000_000n);
      // And back:
      const back = rescaleCost(result, 8, 0);
      expect(back).toBe(1n);
    });

    it("handles zero cost on upscale", () => {
      expect(rescaleCost(0n as Cost, 2, 8)).toBe(0n);
    });
  });

  describe("downscaling (toPrecision < fromPrecision)", () => {
    it("scales 8 → 3 correctly (÷10^5)", () => {
      // 2_830_000_000n (precision 8) → 28300n (precision 3)
      const result = rescaleCost(2_830_000_000n as Cost, 8, 3);
      expect(result).toBe(28300n);
    });

    it("truncates toward zero on downscale (floor division)", () => {
      // 2_830_099_999n ÷ 10^5 = 28300.99999 → truncated to 28300
      const result = rescaleCost(2_830_099_999n as Cost, 8, 3);
      expect(result).toBe(28300n);
    });

    it("handles zero cost on downscale", () => {
      expect(rescaleCost(0n as Cost, 8, 2)).toBe(0n);
    });

    it("truncates sub-unit values to zero", () => {
      // 99_999n at precision 8 → 0.00099999, which truncates to 0 at precision 3
      const result = rescaleCost(99_999n as Cost, 8, 3);
      expect(result).toBe(0n);
    });
  });

  describe("roundtrip", () => {
    it("upscale then downscale is identity for aligned values", () => {
      const original = 28300n as Cost;
      const upscaled = rescaleCost(original, 3, 8);
      const roundtripped = rescaleCost(upscaled, 8, 3);
      expect(roundtripped).toBe(original);
    });

    it("downscale then upscale loses sub-unit precision", () => {
      // 2_830_000_001n has a sub-unit part that gets truncated
      const original = 2_830_000_001n as Cost;
      const downscaled = rescaleCost(original, 8, 3); // 28300n
      const roundtripped = rescaleCost(downscaled, 3, 8); // 2_830_000_000n
      expect(roundtripped).toBe(2_830_000_000n);
      expect(roundtripped).not.toBe(original); // Lost 1n
    });
  });

  describe("MAX_SYSTEM_VAL bounds", () => {
    it("allows values up to MAX_SYSTEM_VAL", () => {
      // At precision 0 → 0, MAX_SYSTEM_VAL should pass through
      const result = rescaleCost(MAX_SYSTEM_VAL as Cost, 0, 0);
      expect(result).toBe(MAX_SYSTEM_VAL);
    });

    it("throws when upscaled result exceeds MAX_SYSTEM_VAL", () => {
      // MAX_SYSTEM_VAL at precision 0 → precision 1 would multiply by 10
      expect(() => rescaleCost(MAX_SYSTEM_VAL as Cost, 0, 1)).toThrow(
        "exceeds MAX_SYSTEM_VAL",
      );
    });

    it("does not throw when large value downscales to within bounds", () => {
      // A value just under MAX_SYSTEM_VAL at precision 8, downscaled to 3
      const val = (MAX_SYSTEM_VAL - 1n) as Cost;
      const result = rescaleCost(val, 8, 3);
      expect(result).toBeLessThanOrEqual(MAX_SYSTEM_VAL);
    });
  });

  describe("real-world scenarios", () => {
    it("1000 AMMO deposit at precision 8", () => {
      // Engine deposits: toInternalPrice(1000, 8) = 100_000_000_000n
      // That's already in AMMO scale, no rescale needed. But verify it's within bounds:
      const deposit = 1000n * 10n ** 8n; // 100_000_000_000n
      expect(deposit).toBeLessThan(MAX_SYSTEM_VAL);
    });

    it("trade cost: 100 shares × 0.283 at pricePrecision 3 → AMMO precision 8", () => {
      // computeNotional(100, 283, ...) = 28300n (precision 3 scale)
      // rescale to AMMO: 28300n × 10^5 = 2_830_000_000n
      const tradeCost = rescaleCost(28300n as Cost, 3, 8);
      expect(tradeCost).toBe(2_830_000_000n);

      // Balance after: 100_000_000_000n - 2_830_000_000n = 97_170_000_000n
      const balanceAfter = 100_000_000_000n - tradeCost;
      expect(balanceAfter).toBe(97_170_000_000n);
    });

    it("10M AMMO at precision 8 is within MAX_SYSTEM_VAL (10^18)", () => {
      const tenMillionAmmo = 10_000_000n * 10n ** 8n; // 10^15
      expect(tenMillionAmmo).toBeLessThan(MAX_SYSTEM_VAL);
    });
  });
});
