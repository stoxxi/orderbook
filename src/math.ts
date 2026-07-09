// packages/orderbook/src/math.ts
// runtime math ONLY — no parsing

import {
  MAX_INTEGER_DIGITS,
  MAX_PRICE_VALUE,
  MAX_QUANTITY_VALUE,
  MAX_SYSTEM_VAL,
} from "./constants";
import { Cost, Price, Quantity } from "./types";

/**
 * @deprecated ⚠️ DO NOT USE FOR INSTRUMENT CONFIGURATION
 *
 * This function is UNSAFE for:
 *   - tickSize
 *   - minPrice
 *   - maxPrice
 *   - instrument definitions
 *
 * Reason:
 * - Accepts `number`
 * - Allows IEEE754 rounding
 * - Allows non-canonical formats
 *
 * Use `parseToInternal()` from `instrument` for ALL config paths.
 *
 * This function is retained ONLY for runtime calculations where
 * inputs are already trusted and internal.
 */
function toInternal(displayValue: number | string, precision: number, maxValue: bigint): bigint {
  const valStr = String(displayValue).trim();

  // 1. Basic Format Validation
  if (!/^\d+(\.\d+)?$/.test(valStr)) {
    throw new Error(`Invalid format: ${displayValue}. Must be a non-negative number.`);
  }

  const parts = valStr.split(".");
  const wholePart = parts[0];

  // 2. Security: Prevent BigInt overflow attacks
  if (wholePart.length > MAX_INTEGER_DIGITS) {
    throw new Error(`Value exceeds maximum safe integer digits (${MAX_INTEGER_DIGITS}).`);
  }

  // 3. Precision Validation
  if (parts[1] && parts[1].length > precision) {
    throw new Error(
      `Value ${displayValue} has more precision than the allowed ${precision} decimals.`,
    );
  }

  // 4. Scaling
  const fractionPart = (parts[1] || "").padEnd(precision, "0");
  const scaledValue = BigInt(wholePart + fractionPart);

  // 5. Range Validation
  if (scaledValue > maxValue * BigInt(10 ** precision)) {
    throw new Error(`Value ${displayValue} exceeds maximum allowed system value.`);
  }

  return scaledValue;
}

// --- PUBLIC PRICE UTILITIES ---

/**
 * @deprecated ⚠️ Runtime use ONLY.
 *
 * DO NOT use for:
 *  - tickSize
 *  - minPrice
 *  - maxPrice
 *  - instrument configuration
 *
 * For config paths, use:
 *   parseToInternal(canonicalString, precision)
 */
export function toInternalPrice(displayPrice: number | string, precision: number): Price {
  return toInternal(displayPrice, precision, MAX_PRICE_VALUE) as Price;
}

/**
 * Formats a scaled internal price back to a display decimal string.
 * Exact (pure string manipulation, no floats); keeps trailing zeros
 * (`19995n`, precision 2 → `"199.95"`; `1990n` → `"19.90"`).
 *
 * @param internalPrice Scaled integer price.
 * @param precision Number of decimal places the price is scaled by.
 */
export function fromInternalPrice(internalPrice: Price, precision: number): string {
  if (precision === 0) return internalPrice.toString();
  const priceStr = internalPrice.toString().padStart(precision + 1, "0");
  const whole = priceStr.slice(0, -precision);
  const fraction = priceStr.slice(-precision);
  return `${whole}.${fraction}`;
}

// --- PUBLIC QUANTITY UTILITIES ---

/**
 * @deprecated ⚠️ Runtime use ONLY.
 *
 * DO NOT use for:
 *  - tickSize
 *  - minPrice
 *  - maxPrice
 *  - instrument configuration
 *
 * For config paths, use:
 *   parseToInternal(canonicalString, precision)
 */
export function toInternalQuantity(displayQty: number | string, precision: number): Quantity {
  return toInternal(displayQty, precision, MAX_QUANTITY_VALUE) as Quantity;
}

/**
 * Formats a scaled internal quantity back to a display decimal string.
 * Exact (pure string manipulation, no floats); unlike
 * {@link fromInternalPrice}, trailing fraction zeros are trimmed
 * (`1500n`, precision 3 → `"1.5"`).
 *
 * @param internalQty Scaled integer quantity.
 * @param precision Number of decimal places the quantity is scaled by.
 */
export function fromInternalQuantity(internalQty: Quantity, precision: number): string {
  if (precision === 0) return internalQty.toString();
  const qtyStr = internalQty.toString().padStart(precision + 1, "0");
  const whole = qtyStr.slice(0, -precision);
  // Quantities usually look better with trailing zeros removed (e.g. 1.5 instead of 1.500)
  const fraction = qtyStr.slice(-precision).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

// --- HFT CALCULATION ENGINE ---

/**
 * Formula: (Quantity * Price) / 10^QuantityPrecision
 * Returns the cost in the currency's scaled units (e.g. cents).
 */
export function computeNotional(
  qtyInternal: Quantity,
  pxInternal: Price,
  quantityScaleFactor: bigint,
): Cost {
  return (qtyInternal * pxInternal) / quantityScaleFactor;
}

/**
 * Formula: (Balance * 10^QuantityPrecision) / Price
 * Returns the maximum quantity a user can afford.
 */
export function calculateMaxQuantity(
  balanceInternal: Cost,
  pxInternal: Price,
  quantityScaleFactor: bigint,
): Quantity {
  if (pxInternal <= 0n) return 0n as Quantity;
  return ((balanceInternal * quantityScaleFactor) / pxInternal) as Quantity;
}

// --- MARKET ORDER PROTECTION (v3.0+) ---

/**
 * Calculates the raw maximum affordable price for a given quantity.
 * Used for affordability checks BEFORE tick-snapping.
 *
 * PERFORMANCE (v3.1): Uses pre-computed scale factor from Instrument.
 * This eliminates 70-150ns of BigInt exponentiation per order.
 *
 * SAFETY (v3.5): Clamps to maxPrice to prevent BigInt explosion on dust quantities.
 *
 * Formula: min((Balance * quantityScaleFactor) / Quantity, maxPrice)
 *
 * Example:
 *   Balance: 500,000n (5,000.00 with pricePrecision 2)
 *   Quantity: 10,000n (100 units with quantityPrecision 2)
 *   quantityScaleFactor: 100n (pre-computed 10^2)
 *   maxPrice: 1,000,000n (10,000.00 ceiling)
 *   Result: (500,000n * 100n) / 10,000n = 5,000n → 50.00 per unit (within bounds)
 *
 * Edge case (dust quantity):
 *   Balance: 1,000,000n (10,000.00)
 *   Quantity: 1n (0.01 units - dust)
 *   maxPrice: 1,000,000n (10,000.00 ceiling)
 *   Uncapped: (1,000,000n * 100n) / 1n = 100,000,000n → 1,000,000.00 (insane!)
 *   Clamped: min(100,000,000n, 1,000,000n) = 1,000,000n → 10,000.00 (safe)
 *
 * @param balanceInternal Available balance in scaled units (e.g., cents)
 * @param qtyInternal Desired quantity in scaled units
 * @param quantityScaleFactor Pre-computed 10^quantityPrecision from Instrument
 * @param maxPrice Maximum valid price from Instrument (bounds calculation)
 * @returns Raw price cap (floor division, clamped to maxPrice)
 */
export function calculateRawPriceCap(
  balanceInternal: Cost,
  qtyInternal: Quantity,
  quantityScaleFactor: bigint,
  maxPrice: Price,
): Price {
  if (qtyInternal <= 0n) return 0n as Price;

  // Floor division ensures we NEVER round up
  // Guarantees: (rawCap * qty) / scaleFactor ≤ balance
  const uncappedPrice = ((balanceInternal * quantityScaleFactor) / qtyInternal) as Price;

  // P1 (v3.5): Clamp to maxPrice to prevent BigInt limb explosion on dust quantities
  // This ensures all prices fit within instrument bounds and prevents DOS via huge BigInts
  return uncappedPrice > maxPrice ? maxPrice : uncappedPrice;
}

/**
 * Snaps a price down to the nearest valid tick size.
 * Used to ensure transformed orders comply with exchange tick rules.
 *
 * Example:
 *   price: 5,001n (50.01)
 *   tickSize: 100n (1.00)
 *   Result: 5,000n (50.00)
 *
 * @param price Price in scaled units
 * @param tickSize Minimum price increment in scaled units
 * @returns Price snapped down to nearest tick
 */
export function snapToTick(price: Price, tickSize: Price): Price {
  if (tickSize <= 0n) return price;
  return ((price / tickSize) * tickSize) as Price;
}

// --- PRECISION SCALE CONVERSION ---

/**
 * Converts a cost/balance value from one precision scale to another.
 *
 * Primary use case: converting trade costs from a market's pricePrecision
 * to the platform's BALANCE_PRECISION before adjusting buyingPower.
 *
 * When toPrecision > fromPrecision (upscaling), the conversion is exact.
 * When toPrecision < fromPrecision (downscaling), integer division truncates
 * toward zero — callers should validate this is acceptable.
 *
 * @param cost The value to rescale (in fromPrecision scale)
 * @param fromPrecision Source precision (e.g., instrument pricePrecision)
 * @param toPrecision Target precision (e.g., BALANCE_PRECISION)
 * @returns Cost rescaled to toPrecision
 * @throws Error if rescaled value exceeds MAX_SYSTEM_VAL
 */
export function rescaleCost(cost: Cost, fromPrecision: number, toPrecision: number): Cost {
  if (fromPrecision === toPrecision) return cost;

  let result: Cost;
  if (toPrecision > fromPrecision) {
    result = (cost * 10n ** BigInt(toPrecision - fromPrecision)) as Cost;
  } else {
    result = (cost / 10n ** BigInt(fromPrecision - toPrecision)) as Cost;
  }

  if (result > MAX_SYSTEM_VAL) {
    throw new Error(
      `Rescaled cost ${result} exceeds MAX_SYSTEM_VAL (${MAX_SYSTEM_VAL}). ` +
        `Original: ${cost} (precision ${fromPrecision} → ${toPrecision}).`,
    );
  }

  return result;
}

// export { parseToInternal } from "./instrument";
