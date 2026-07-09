// packages/orderbook/src/amm/math.ts

import { AMM_MATH_SCALE } from "../constants";
import { Price, Quantity } from "../types";

/**
 * Calculates the Micro-Price (Imbalance-Weighted Mid).
 *
 * Optimized to avoid 10^36 intermediate overflows by using the form:
 * P_bid + (Spread * BidQty / TotalQty)
 *
 * @returns The weighted price tilted towards the side with more pressure.
 */
export function calculateMicroPrice(
  bestBid: Price,
  bidQty: Quantity,
  bestAsk: Price,
  askQty: Quantity,
): Price {
  const totalQty = bidQty + askQty;
  if (totalQty === 0n) return 0n as Price;

  const spread = bestAsk - bestBid;
  // Scale up before division to retain precision during BigInt floor division.
  // Without this, when spread is small (e.g., 1 tick), the fractional tilt
  // truncates to 0 and microprice equals bestBid.
  const scaledTilt = (spread * AMM_MATH_SCALE * bidQty) / totalQty;
  return (bestBid + scaledTilt / AMM_MATH_SCALE) as Price;
}

/**
 * Calculates the Reservation Price (The AMM's "Neutral" point).
 *
 * Formula: r = S - (q * gamma * sigmaSq)
 *
 * 1. Divides by AMM_MATH_SCALE twice (once for gamma, once for sigmaSq).
 * 2. Accounts for quantityScaleFactor to get raw units.
 *
 * @param microPrice The current Micro-Price (BigInt)
 * @param inventory Current signed position (BigInt, positive = long)
 * @param gamma Risk Aversion (BigInt scaled by 1e6)
 * @param sigmaSq Volatility Squared (BigInt scaled by 1e6)
 */
export function calculateReservationPrice(
  microPrice: Price,
  inventory: Quantity,
  gamma: bigint,
  sigmaSq: bigint,
  quantityScaleFactor: bigint, // handles inventory scaling
): Price {
  // adjustment = (q * γ * σ²)
  // adjustment = (inventory_units * gamma_float * sigmaSq_float)
  // In BigInt: (inventory * gamma * sigmaSq) / (qtyScale * MATH_SCALE * MATH_SCALE)

  const numerator = inventory * gamma * sigmaSq;
  const denominator = quantityScaleFactor * AMM_MATH_SCALE * AMM_MATH_SCALE;

  if (denominator === 0n) return microPrice;

  const adjustment = numerator / denominator;
  return (microPrice - (adjustment as Price)) as Price;
}

/**
 * Calculates the optimal spread around the reservation price.
 * Simplified Stoikov: spread = (gamma * sigmaSq) + baseSpread
 * Divides by AMM_MATH_SCALE twice to normalize risk product.
 */
export function calculateOptimalSpread(gamma: bigint, sigmaSq: bigint, baseSpread: bigint): bigint {
  // (gamma * sigmaSq) / (1e6 * 1e6)
  const riskPremium = (gamma * sigmaSq) / (AMM_MATH_SCALE * AMM_MATH_SCALE);
  return riskPremium + baseSpread;
}
