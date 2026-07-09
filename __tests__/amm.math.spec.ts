// packages/orderbook/__tests__/amm.math.spec.ts
import { describe, expect, it } from "bun:test";
import { calculateMicroPrice, calculateReservationPrice } from "../src/amm/math";

describe("AMM Math Kernel (HFT Audit)", () => {
  const SCALE = 1_000_000n;

  describe("calculateMicroPrice", () => {
    it("should tilt price towards the ask when bid volume is dominant", () => {
      const bid = 10000n; // 100.00
      const ask = 10100n; // 101.00
      const bidQty = 900n;
      const askQty = 100n;

      const micro = calculateMicroPrice(bid, bidQty, ask, askQty);
      // Imbalance is 90% bid, so price should be 100.90
      expect(micro).toBe(10090n);
    });

    it("should handle zero quantity gracefully", () => {
      expect(calculateMicroPrice(100n, 0n, 200n, 0n)).toBe(0n);
    });

    it("should prevent 10^36 overflow with large quantities and prices", () => {
      const largePrice = 10n ** 15n;
      const largeQty = 10n ** 15n;
      // This would be (10^15 * 10^15) + (10^15 * 10^15) = 2 * 10^30 in intermediate
      // Our formula keeps it bounded.
      const result = calculateMicroPrice(largePrice, largeQty, largePrice * 2n, largeQty);
      expect(result).toBe(largePrice + largePrice / 2n);
    });
  });

  describe("calculateReservationPrice", () => {
    const gamma = 100_000n; // 0.1 scaled by 1e6
    const sigmaSq = 200_000n; // 0.2 scaled by 1e6
    const qtyScale = 1n; // Test uses raw units

    it("should lower the reservation price when inventory is long (positive)", () => {
      const micro = 5000n;
      const inventory = 1000n; // Long 1000 units

      // Math: 5000 - (1000 * 100,000 * 200,000) / (1 * 1,000,000 * 1,000,000)
      // Math: 5000 - (20,000,000,000,000) / (1,000,000,000,000)
      // Math: 5000 - 20 = 4980
      const r = calculateReservationPrice(micro, inventory, gamma, sigmaSq, qtyScale);
      expect(r).toBe(4980n);
    });

    it("should raise the reservation price when inventory is short (negative)", () => {
      const micro = 5000n;
      const inventory = -1000n; // Short 1000 units

      const r = calculateReservationPrice(micro, inventory, gamma, sigmaSq, qtyScale);
      expect(r).toBe(5020n);
    });

    it("should be deterministic and drift-free", () => {
      const r1 = calculateReservationPrice(5000n, 100n, gamma, sigmaSq, qtyScale);
      const r2 = calculateReservationPrice(5000n, 100n, gamma, sigmaSq, qtyScale);
      expect(r1).toBe(r2);
    });

    it("should handle negative inventory without overflow", () => {
      const micro = 5000n;
      const inventory = -1000000000000000000n; // Extreme negative (short 10^18 units)
      const gamma = 100_000n;
      const sigmaSq = 200_000n;
      const r = calculateReservationPrice(micro, inventory, gamma, sigmaSq, qtyScale);
      expect(r).toBeGreaterThan(micro); // Should raise price
      expect(r).not.toBe(Infinity); // No overflow
    });
  });
});
