// packages/orderbook/__tests__/instrument.spec.ts
// P0: Critical validation tests for instrument configuration
//
// These tests verify security-critical validation logic that prevents:
// - DoS attacks via BigInt limb explosion
// - Silent data corruption via truncation
// - Invalid instrument configurations

import { describe, test, expect } from "bun:test";
import {
  parseToInternal,
  createInstrument,
  toCanonicalDecimal,
} from "../src/instrument";

describe("parseToInternal", () => {
  describe("Valid Inputs", () => {
    test("should parse simple decimal correctly", () => {
      expect(parseToInternal("1.50", 2, "price")).toBe(150n);
    });

    test("should parse integer with required decimals", () => {
      expect(parseToInternal("100.00", 2, "price")).toBe(10000n);
    });

    test("should parse small decimal correctly", () => {
      expect(parseToInternal("0.01", 2, "price")).toBe(1n);
    });

    test("should parse high precision correctly (8 decimals)", () => {
      expect(parseToInternal("0.00000001", 8, "satoshi")).toBe(1n);
    });

    test("should parse value with fewer decimals than precision", () => {
      expect(parseToInternal("1.5", 2, "price")).toBe(150n);
    });

    test("should parse large values correctly", () => {
      expect(parseToInternal("999999.99", 2, "price")).toBe(99999999n);
    });
  });

  describe("P0: DoS Prevention - Input Length Limit", () => {
    test("should reject inputs longer than 40 characters", () => {
      const longInput = "1" + "0".repeat(50); // 51 characters
      expect(() => parseToInternal(longInput as any, 2, "price")).toThrow(
        /Input too long/
      );
    });

    test("should accept inputs at exactly 40 characters", () => {
      // 38 digits + decimal + 1 digit = 40 chars
      const maxInput = "1" + "2".repeat(36) + ".99";
      expect(maxInput.length).toBe(40);
      expect(() => parseToInternal(maxInput as any, 2, "price")).not.toThrow();
    });
  });

  describe("P0: Scientific Notation Rejection", () => {
    test("should reject lowercase scientific notation", () => {
      expect(() => parseToInternal("1e-8" as any, 8, "price")).toThrow(
        /Scientific notation not supported/
      );
    });

    test("should reject uppercase scientific notation", () => {
      expect(() => parseToInternal("1E8" as any, 2, "price")).toThrow(
        /Scientific notation not supported/
      );
    });

    test("should reject mixed case scientific notation", () => {
      expect(() => parseToInternal("1.5e+2" as any, 2, "price")).toThrow(
        /Scientific notation not supported/
      );
    });
  });

  describe("P0: Canonical Format Validation", () => {
    test("should reject leading zeros (non-canonical)", () => {
      expect(() => parseToInternal("007.50" as any, 2, "price")).toThrow(
        /canonical non-negative decimal/
      );
    });

    test("should reject leading zeros before decimal", () => {
      expect(() => parseToInternal("00.50" as any, 2, "price")).toThrow(
        /canonical non-negative decimal/
      );
    });

    test("should accept '0.xx' format (valid canonical)", () => {
      expect(parseToInternal("0.50", 2, "price")).toBe(50n);
    });

    test("should reject empty string", () => {
      expect(() => parseToInternal("" as any, 2, "price")).toThrow(/empty string/);
    });

    test("should reject whitespace-only string", () => {
      expect(() => parseToInternal("   " as any, 2, "price")).toThrow(/empty string/);
    });

    test("should reject negative values", () => {
      expect(() => parseToInternal("-1.00" as any, 2, "price")).toThrow(
        /canonical non-negative decimal/
      );
    });

    test("should reject plus sign prefix", () => {
      expect(() => parseToInternal("+1.00" as any, 2, "price")).toThrow(
        /canonical non-negative decimal/
      );
    });
  });

  describe("P0: Precision Validation (No Silent Truncation)", () => {
    test("should reject over-precision input (3 decimals for precision 2)", () => {
      expect(() => parseToInternal("1.019" as any, 2, "price")).toThrow(
        /has 3 decimal places.*precision is 2/
      );
    });

    test("should reject high over-precision", () => {
      expect(() => parseToInternal("0.000000001" as any, 8, "price")).toThrow(
        /has 9 decimal places.*precision is 8/
      );
    });
  });

  describe("P1: Zero Value Rejection", () => {
    test("should reject explicit zero", () => {
      expect(() => parseToInternal("0.00" as any, 2, "price")).toThrow(
        /must be strictly positive/
      );
    });

    test("should reject bare zero with precision requirement", () => {
      expect(() => parseToInternal("0" as any, 2, "price")).toThrow(
        /Explicit decimal form required/
      );
    });
  });

  describe("Edge Cases", () => {
    test("should handle precision 0 correctly", () => {
      expect(parseToInternal("100", 0, "price")).toBe(100n);
    });

    test("should trim whitespace from input", () => {
      expect(parseToInternal("  1.50  " as any, 2, "price")).toBe(150n);
    });

    test("should include field name in error messages", () => {
      expect(() => parseToInternal("invalid" as any, 2, "tickSize")).toThrow(
        /tickSize/
      );
    });
  });
});

describe("createInstrument", () => {
  describe("Valid Configurations", () => {
    test("should create instrument with valid parameters", () => {
      const instrument = createInstrument(
        "TEST/USD",
        2, // pricePrecision
        8, // quantityPrecision
        "0.01", // tickSize
        "1.00", // minPrice
        "10000.00" // maxPrice
      );

      expect(instrument.symbol).toBe("TEST/USD");
      expect(instrument.pricePrecision).toBe(2);
      expect(instrument.quantityPrecision).toBe(8);
      expect(instrument.tickSize).toBe(1n);
      expect(instrument.minPrice).toBe(100n);
      expect(instrument.maxPrice).toBe(1000000n);
      expect(instrument.priceScaleFactor).toBe(100n);
      expect(instrument.quantityScaleFactor).toBe(100000000n);
    });

    test("should create instrument with high precision", () => {
      const instrument = createInstrument(
        "BTC/USD",
        8,
        8,
        "0.00000001",
        "0.00000001",
        "100000.00000000"
      );

      expect(instrument.tickSize).toBe(1n);
      expect(instrument.minPrice).toBe(1n);
      expect(instrument.priceScaleFactor).toBe(100000000n);
    });
  });

  describe("P0: Precision Bounds", () => {
    test("should reject negative pricePrecision", () => {
      expect(() =>
        createInstrument("TEST", -1, 2, "0.01", "1.00", "100.00")
      ).toThrow(/pricePrecision.*Must be between 0 and 18/);
    });

    test("should reject pricePrecision > 18", () => {
      expect(() =>
        createInstrument("TEST", 19, 2, "0.01", "1.00", "100.00")
      ).toThrow(/pricePrecision.*Must be between 0 and 18/);
    });

    test("should reject negative quantityPrecision", () => {
      expect(() =>
        createInstrument("TEST", 2, -1, "0.01", "1.00", "100.00")
      ).toThrow(/quantityPrecision.*Must be between 0 and 18/);
    });

    test("should reject quantityPrecision > 18", () => {
      expect(() =>
        createInstrument("TEST", 2, 19, "0.01", "1.00", "100.00")
      ).toThrow(/quantityPrecision.*Must be between 0 and 18/);
    });

    test("should accept precision at boundary (18)", () => {
      const instrument = createInstrument(
        "TEST",
        18,
        18,
        "0.000000000000000001",
        "0.000000000000000001",
        "1.000000000000000000"
      );
      expect(instrument.priceScaleFactor).toBe(10n ** 18n);
    });
  });

  describe("P0: Modulo Invariants (Tick Coherence)", () => {
    test("should reject minPrice not divisible by tickSize", () => {
      // tickSize = 0.03, minPrice = 0.05 (not a multiple of 0.03)
      expect(() =>
        createInstrument("TEST", 2, 2, "0.03", "0.05", "10.00")
      ).toThrow(/minPrice.*must be a multiple of tickSize/);
    });

    test("should reject maxPrice not divisible by tickSize", () => {
      // tickSize = 0.03, maxPrice = 10.01 (not a multiple of 0.03)
      expect(() =>
        createInstrument("TEST", 2, 2, "0.03", "0.03", "10.01")
      ).toThrow(/maxPrice.*must be a multiple of tickSize/);
    });

    test("should accept valid modulo alignment", () => {
      // tickSize = 0.05, minPrice = 0.10, maxPrice = 10.00 (all multiples)
      const instrument = createInstrument(
        "TEST",
        2,
        2,
        "0.05",
        "0.10",
        "10.00"
      );
      expect(instrument.minPrice % instrument.tickSize).toBe(0n);
      expect(instrument.maxPrice % instrument.tickSize).toBe(0n);
    });
  });

  describe("P1: Range Coherence", () => {
    test("should reject minPrice less than tickSize", () => {
      // tickSize = 0.10, minPrice = 0.05
      expect(() =>
        createInstrument("TEST", 2, 2, "0.10", "0.05", "10.00")
      ).toThrow(/minPrice.*cannot be less than tickSize/);
    });

    test("should reject maxPrice less than minPrice", () => {
      expect(() =>
        createInstrument("TEST", 2, 2, "0.01", "10.00", "5.00")
      ).toThrow(/maxPrice.*cannot be less than minPrice/);
    });

    test("should accept minPrice equal to tickSize", () => {
      const instrument = createInstrument(
        "TEST",
        2,
        2,
        "0.01",
        "0.01",
        "100.00"
      );
      expect(instrument.minPrice).toBe(instrument.tickSize);
    });

    test("should accept maxPrice equal to minPrice", () => {
      const instrument = createInstrument(
        "TEST",
        2,
        2,
        "1.00",
        "1.00",
        "1.00"
      );
      expect(instrument.maxPrice).toBe(instrument.minPrice);
    });
  });

  describe("Scale Factor Caching", () => {
    test("should pre-compute price scale factor", () => {
      const instrument = createInstrument(
        "TEST",
        4,
        2,
        "0.0001",
        "0.0001",
        "1000.0000"
      );
      expect(instrument.priceScaleFactor).toBe(10000n);
    });

    test("should pre-compute quantity scale factor", () => {
      const instrument = createInstrument(
        "TEST",
        2,
        6,
        "0.01",
        "0.01",
        "1000.00"
      );
      expect(instrument.quantityScaleFactor).toBe(1000000n);
    });
  });
});

describe("toCanonicalDecimal", () => {
  describe("String Input (Preferred)", () => {
    test("should pass through valid string", () => {
      const result = toCanonicalDecimal("1.50", 2);
      expect(result).toBe("1.50");
    });

    test("should validate string and reject invalid", () => {
      expect(() => toCanonicalDecimal("invalid", 2)).toThrow();
    });
  });

  describe("Number Input (Config Boundary)", () => {
    test("should convert number to fixed decimal string", () => {
      const result = toCanonicalDecimal(1.5, 2);
      expect(result).toBe("1.50");
    });

    test("should handle floating point precision issues", () => {
      // 0.1 + 0.2 = 0.30000000000000004 in JavaScript
      const result = toCanonicalDecimal(0.1 + 0.2, 2);
      expect(result).toBe("0.30");
    });

    test("should round number to specified precision", () => {
      const result = toCanonicalDecimal(1.999, 2);
      expect(result).toBe("2.00");
    });
  });

  describe("CanonicalDecimalString Input (Passthrough)", () => {
    test("should accept already-branded string", () => {
      const branded = "5.00" as any;
      const result = toCanonicalDecimal(branded, 2);
      expect(result).toBe("5.00");
    });
  });
});
