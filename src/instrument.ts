// packages/orderbook/src/instrument.ts

import { CanonicalDecimalString, PriceScaleFactor, QuantityScaleFactor } from "./types";

/**
 * Defines the precision and scaling configuration for a specific trading instrument.
 * This object is required to correctly handle fractional prices and quantities
 * by converting them to scaled integers for internal calculations.
 *
 * v3.5 ENHANCEMENTS:
 * - All price values are bigint (tickSize, minPrice, maxPrice)
 * - Scale factors are bigint (cached for O(1) performance)
 * - Strict coherence validation (modulo invariants)
 */
export interface Instrument {
  /** The human-readable symbol, e.g., 'BTC/USD' */
  readonly symbol: string;

  /** The number of decimal places for the price. E.g., 2 for USD cents. */
  readonly pricePrecision: number;

  /** The number of decimal places for the quantity. E.g., 8 for BTC satoshis. */
  readonly quantityPrecision: number;

  /**
   * CRITICAL FIX (v3.2): tickSize MUST be bigint to prevent TypeError in division.
   * Using number here would crash: (bigint / number) throws TypeError in JavaScript.
   * Scaled tick size in internal units (e.g., 1n for 0.01 USD when pricePrecision=2).
   */
  readonly tickSize: bigint;

  /**
   * NEW (v3.3): Minimum valid price (prevents micro-underflow orders).
   * Example: If minPrice = 100n (1.00 with precision 2), orders below 1.00 are rejected.
   * INVARIANT (v3.4): minPrice % tickSize === 0n (exchange validity).
   */
  readonly minPrice: bigint;

  /**
   * NEW (v3.5): Maximum valid price (prevents BigInt explosion, bounds all calculations).
   * CRITICAL: Prevents dust quantities from producing uncapped prices.
   * Example: If maxPrice = 1000000n (10,000.00 with precision 2), caps are bounded.
   * INVARIANT (v3.5): maxPrice % tickSize === 0n (tick coherence).
   */
  readonly maxPrice: bigint;

  /**
   * NEW (v3.1): Pre-computed scale factors for O(1) access.
   * These are computed ONCE when the instrument is created.
   *
   * The factor to scale prices by. E.g., 100n for 2 decimal places.
   * CRITICAL: Must be bigint for use in BigInt arithmetic without exponentiation overhead.
   * Cached at instrument creation to eliminate 70-150ns per order.
   */
  readonly priceScaleFactor: PriceScaleFactor;

  /**
   * The factor to scale quantities by. E.g., 100_000_000n for 8 decimal places.
   * CRITICAL: Must be bigint for use in BigInt arithmetic without exponentiation overhead.
   * Cached at instrument creation to eliminate 70-150ns per order.
   */
  readonly quantityScaleFactor: QuantityScaleFactor;
}

/**
 * Safely parses a decimal string into a scaled BigInt.
 * CRITICAL (v3.3): This prevents float precision errors in instrument configuration.
 * CRITICAL (v3.4): Validates instead of truncating to prevent silent data corruption.
 * CRITICAL (v3.5): Rejects non-canonical format (leading zeros).
 *
 * Example:
 *   parseToInternal("0.00000002", 8) → 2n
 *   Without this: Math.round(0.00000002 * 10**8) → 1n (50% error!)
 *
 * v3.4 Fix: Rejects over-precision inputs instead of silently truncating
 *   parseToInternal("0.019", 2) → Error (was: silently became 0.01)
 *
 * v3.5 Fix: Rejects non-canonical format
 *   parseToInternal("007.50", 2) → Error (leading zeros not allowed)
 *
 * @param value Decimal string (e.g., "0.01", "1.5")
 * @param precision Number of decimal places
 * @param fieldName Field name for error messages (e.g., "tickSize")
 * @returns Scaled BigInt in internal units
 * @throws Error if value has more decimals than precision, or invalid format
 */
export function parseToInternal(
  value: CanonicalDecimalString,
  precision: number,
  fieldName: string = "value",
): bigint {
  // Sanitize input - trim whitespace
  const trimmed = String(value || "").trim();

  // Reject empty strings
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${fieldName}: empty string`);
  }

  // Prevent BigInt Limb Explosion (DoS Attack)
  // 40 characters is enough for 18 decimals + 21 integer digits.
  // A string like "1" followed by 1 million zeros would crash the process.
  if (trimmed.length > 40) {
    throw new Error(`Invalid ${fieldName}: Input too long. Max 40 characters allowed.`);
  }

  // P1 (v3.4): Reject scientific notation (e.g., "1e-8")
  // In production, exchanges require explicit decimal notation for clarity
  if (/[eE]/.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}". Scientific notation not supported. ` +
        `Please use decimal notation (e.g., "0.00000001" instead of "1e-8").`,
    );
  }

  // Basic format validation and block leading zeros
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: "${value}". Must be a canonical non-negative decimal.`);
  }

  // P2 (v3.5): Canonical decimal format - reject leading zeros (e.g., "007.50", "00.01")
  // This is required for exchange compliance and prevents ambiguous representations
  // Exception: "0" and "0.xxx" are valid
  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (wholePart.length > 1 && wholePart[0] === "0") {
    throw new Error(
      `Invalid ${fieldName}: "${value}". Leading zeros not allowed in canonical format. ` +
        `Use "${trimmed.replace(/^0+/, "")}" instead.`,
    );
  }

  // P1 (v3.5): parseToInternal silently accepts "0" with precision > 0
  if (wholePart === "0" && fractionPart.length === 0 && precision > 0) {
    throw new Error(
      `Invalid ${fieldName}: "${value}". Explicit decimal form required (e.g. "0.${"0".repeat(precision)}").`,
    );
  }

  // P0 (v3.4): CRITICAL FIX - Validate instead of truncate
  // Old code: .slice(0, precision) would silently truncate "0.019" → "0.01"
  // This is silent data corruption that breaks tick/minPrice specifications
  if (fractionPart.length > precision) {
    throw new Error(
      `Invalid ${fieldName}: "${value}" has ${fractionPart.length} decimal places, ` +
        `but instrument precision is ${precision}. ` +
        `Please round to ${precision} decimals or adjust precision.`,
    );
  }

  // Pad fraction to exact precision (e.g., "1.5" with precision 2 → "150")
  const paddedFraction = fractionPart.padEnd(precision, "0");

  const internalValue = BigInt(wholePart + paddedFraction);
  // v3.5.1: Strictly forbid zero values for price-related invariants
  if (internalValue === 0n) {
    throw new Error(`Invalid ${fieldName}: "${value}". Value must be strictly positive.`);
  }

  return internalValue;
}

/**
 * A factory function to create a new, immutable Instrument configuration object.
 * It pre-calculates the scale factors from the precision values for performance.
 *
 * v3.3/v3.4/v3.5 ENHANCEMENTS:
 * - String-based ingestion (prevents float precision loss)
 * - Validates instead of truncates (prevents silent data corruption)
 * - Enforces modulo invariants (ensures exchange validity)
 * - Caches scale factors (eliminates 70-150ns per order)
 * - Caps precision at 18 decimals (prevents BigInt OOM)
 * - Validates maxPrice coherence (tick alignment)
 *
 * @param symbol The trading symbol (e.g., 'AAPL', 'BTC/USD').
 * @param pricePrecision The number of decimal places to support for price (0-18).
 * @param quantityPrecision The number of decimal places to support for quantity (0-18).
 * @param tickSizeInput Tick size as decimal string (e.g., "0.01" for penny increments).
 * @param minPriceInput Minimum valid price as decimal string (e.g., "1.00").
 * @param maxPriceInput Maximum valid price as decimal string (e.g., "10000.00").
 * @returns An immutable Instrument configuration object.
 * @throws Error if any validation fails (precision, format, coherence)
 */
export function createInstrument(
  symbol: string,
  pricePrecision: number,
  quantityPrecision: number,
  tickSizeInput: CanonicalDecimalString, // CRITICAL FIX (v3.3): String to prevent float precision loss
  minPriceInput: CanonicalDecimalString, // NEW (v3.3): Minimum valid price
  maxPriceInput: CanonicalDecimalString, // NEW (v3.5): Maximum valid price
): Instrument {
  // P2/P1 (v3.1/v3.5): Precision governance (0-18 to prevent BigInt limb explosion)
  if (pricePrecision < 0 || pricePrecision > 18) {
    throw new Error(
      `Invalid pricePrecision: ${pricePrecision}. Must be between 0 and 18 ` +
        `to prevent BigInt limb explosion and keep matching in its measured latency envelope (see BENCHMARKS.md).`,
    );
  }
  if (quantityPrecision < 0 || quantityPrecision > 18) {
    throw new Error(
      `Invalid quantityPrecision: ${quantityPrecision}. Must be between 0 and 18 ` +
        `to prevent BigInt limb explosion and keep matching in its measured latency envelope (see BENCHMARKS.md).`,
    );
  }

  // CRITICAL FIX (v3.3/v3.4/v3.5): Parse strings to prevent float precision errors
  // v3.4: Validates instead of truncating (e.g., "0.019" with precision 2 throws error)
  // v3.5: Rejects non-canonical format (e.g., "007.50" throws error)
  // Example: "0.00000002" with precision 8 → 2n (correct)
  //          0.00000002 * 10**8 → 1.9999998 → 1n (50% error!)
  const tickSize = parseToInternal(tickSizeInput, pricePrecision, "tickSize");
  const minPrice = parseToInternal(minPriceInput, pricePrecision, "minPrice");
  const maxPrice = parseToInternal(maxPriceInput, pricePrecision, "maxPrice");

  // P1 (v3.5): Runtime tickSize guard (defensive, even though validated by parseToInternal)
  if (tickSize <= 0n) {
    throw new Error(`tickSize must be positive, got: ${tickSizeInput}`);
  }

  // P1 (v3.3): Range coherence
  if (minPrice < tickSize) {
    throw new Error(
      `minPrice (${minPriceInput}) cannot be less than tickSize (${tickSizeInput}). ` +
        `This would create orders that can never match any valid price level.`,
    );
  }
  if (maxPrice < minPrice) {
    throw new Error(
      `maxPrice (${maxPriceInput}) cannot be less than minPrice (${minPriceInput}). ` +
        `This would create an untradeable instrument.`,
    );
  }

  // P0 (v3.4): CRITICAL FIX - Modulo invariant for exchange validity
  // minPrice must be a multiple of tickSize, otherwise the instrument is logically broken
  //
  // Example of the bug this prevents:
  //   tickSize = 0.03 (valid prices: 0.03, 0.06, 0.09, ...)
  //   minPrice = 0.05 (NOT a multiple of 0.03)
  //   Result: minPrice is unreachable, instrument can never trade
  //
  // This would cause all orders to be rejected by the post-snap guard because
  // snappedPrice would always be < minPrice for borderline cases
  if (minPrice % tickSize !== 0n) {
    throw new Error(
      `minPrice (${minPriceInput}) must be a multiple of tickSize (${tickSizeInput}). ` +
        `Current minPrice is ${minPrice}, tickSize is ${tickSize}. ` +
        `Valid minPrice values: ${tickSize}, ${tickSize * 2n}, ${tickSize * 3n}, etc. ` +
        `This ensures all valid price levels are reachable.`,
    );
  }

  // P1 (v3.5): maxPrice coherence - must also be a multiple of tickSize
  // This ensures the price ceiling is reachable and clamping works correctly
  if (maxPrice % tickSize !== 0n) {
    throw new Error(
      `maxPrice (${maxPriceInput}) must be a multiple of tickSize (${tickSizeInput}). ` +
        `Current maxPrice is ${maxPrice}, tickSize is ${tickSize}. ` +
        `Valid maxPrice values: ${tickSize}, ${tickSize * 2n}, ${tickSize * 3n}, etc. ` +
        `This ensures price caps align with valid tick levels.`,
    );
  }

  return {
    symbol,
    pricePrecision,
    quantityPrecision,
    tickSize,
    minPrice,
    maxPrice,
    // Pre-compute scale factors ONCE
    // This eliminates 70-150ns per order by avoiding repeated BigInt exponentiation
    // pricePrecision <= 18 guaranteed above
    priceScaleFactor: 10n ** BigInt(pricePrecision),
    quantityScaleFactor: 10n ** BigInt(quantityPrecision),
  };
}

// --- Overloads (compiler guidance) ---

export function toCanonicalDecimal(
  value: CanonicalDecimalString,
  precision: number,
): CanonicalDecimalString;

export function toCanonicalDecimal(value: string, precision: number): CanonicalDecimalString;

export function toCanonicalDecimal(value: number, precision: number): CanonicalDecimalString;

// --- Implementation (single choke point) ---

/**
 * Converts an external value into a CanonicalDecimalString.
 *
 * ⚠️ CONFIG PATH ONLY
 * This function is the ONLY allowed entry point for floats into
 * instrument configuration.
 *
 * Preferred input: string (from config / DB)
 * Allowed input: number (factory boundary only)
 */
export function toCanonicalDecimal(
  value: number | string | CanonicalDecimalString,
  precision: number,
): CanonicalDecimalString {
  const canonical =
    typeof value === "number"
      ? value.toFixed(precision) // 🔥 loud float normalization
      : value;

  // CRITICAL: branding == validation
  // If this succeeds, the string is provably safe
  parseToInternal(canonical as CanonicalDecimalString, precision);

  return canonical as CanonicalDecimalString;
}

/**
 * SEMANTIC NOTE (v3.4 - P1 Clarification):
 *
 * In this implementation, `availableBalance` (Cost/Balance) is scaled using `pricePrecision`,
 * not a separate `costPrecision`. This is an architectural decision that simplifies the
 * single-currency orderbook.
 *
 * Implications:
 * - `fromInternalPrice()` can be used to display balances (they share the same scale)
 * - If you extend to multi-currency pairs (FX, futures), you MUST introduce separate
 *   `costPrecision` and `fromInternalCost()`
 * - Current assumption: 1 AMMO balance unit = 1 price unit (both scaled by `pricePrecision`)
 *
 * Future-proofing: Consider renaming or adding semantic aliases for clarity in
 * packages/orderbook/src/math.ts or a new utils file:
 *
 * ```typescript
 * // Semantic aliases for clarity
 * export const fromInternalCost = fromInternalPrice;  // Same scale in single-currency
 * export const fromInternalBalance = fromInternalPrice;  // Same scale in single-currency
 * ```
 */
