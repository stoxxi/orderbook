// packages/orderbook/src/orderbook/types.ts

/**
 * Defines the scaling factor for price conversions.
 * A value of 100 means we are tracking prices to 2 decimal places (cents).
 * A value of 10000 would be for 4 decimal places.
 */
export const PRICE_SCALE_FACTOR = 100;

/**
 * Represents the price of an asset as a scaled arbitrary-precision integer.
 * Using bigint guarantees lossless arithmetic for all financial calculations.
 * Example: A price of $199.95 with 2 decimal places is stored as 19995n.
 */
export type Price = bigint;

/**
 * Represents the quantity of an asset as a scaled arbitrary-precision integer.
 */
export type Quantity = bigint;

/**
 * Represents the total cost of a transaction (Price * Quantity).
 */
export type Cost = bigint;

/**
 * Semantic alias for precomputed 10^pricePrecision.
 * Prevents accidental use of raw bigint in scale-sensitive math.
 */
export type PriceScaleFactor = bigint;

/**
 * Semantic alias for precomputed 10^quantityPrecision.
 */
export type QuantityScaleFactor = bigint;

/**
 * A unique server-side identifier for an order.
 */
export type OrderSid = bigint;

/**
 * A unique identifier for a consummated trade.
 */
export type TradeId = number;

/**
 * A unique client-side identifier for an order.
 */
export type OrderId = string;

/**
 * The two supported order types. Note that inside the book the distinction
 * is carried by price: market orders have `price === 0n` (see
 * `Order.isMarket`) or a protective price cap (`isProtectedMarket`).
 */
export type OrderType = "limit" | "market";

/**
 * Represents the trading symbol for an instrument (e.g., 'AAPL', 'GOOG').
 * Renamed from 'Symbol' to avoid collision with the JavaScript primitive.
 */
export type InstrumentSymbol = string;

/**
 * Canonical decimal string that has passed ingestion sanitization.
 * This is the ONLY allowed input type for instrument configuration.
 */
export type CanonicalDecimalString = string & {
  readonly __canonicalDecimal: unique symbol;
};

/**
 * Enumeration for the side of an order (Buy or Sell).
 */
export enum Side {
  BUY,
  SELL,
}

/**
 * Placeholder for the host application's user-id type. The book never
 * inspects user ids except through an injected `STPPolicy`.
 */
export type UserId = unknown;

/**
 * Minimal shape for order `userData` when self-trade prevention needs a
 * user identity (see `UserSTPPolicy`).
 */
export interface UserContext<TUserId = UserId> {
  userId: TUserId;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL TYPE BRANDING (compile-time only)
// Prevents cross-book / cross-symbol misuse of intrusive pointers
// ─────────────────────────────────────────────────────────────

/** @internal Compile-time brand symbol — never exists at runtime. */
export declare const __LimitBrand: unique symbol;

/**
 * @internal Compile-time brand intersected onto `Order._limit` so an
 * intrusive pointer from one book cannot be assigned into another.
 */
export interface LimitOwnerBrand {
  readonly [__LimitBrand]: never;
}

/**
 * Represents a user's account balance as a scaled arbitrary-precision integer.
 */
export type Balance = bigint;

/** Semantic cast: mark an already-scaled bigint as a {@link Price}. */
export const toPrice = (value: bigint): Price => value;
/** Semantic cast: mark an already-scaled bigint as a {@link Quantity}. */
export const toQuantity = (value: bigint): Quantity => value;
/** Semantic cast: mark an already-scaled bigint as a {@link Balance}. */
export const toBalance = (value: bigint): Balance => value;

// ─────────────────────────────────────────────────────────────
// MARKET DATA TYPES
// ─────────────────────────────────────────────────────────────

/** OHLCV candle for a 1-minute time bucket. */
export interface Candle {
  open: Price;
  high: Price;
  low: Price;
  close: Price;
  volume: Quantity;
  startMinute: number;
  closeTime?: number;
}

/** A single price level that has changed since the last depth flush. */
export interface DepthDelta {
  price: Price;
  quantity: Quantity;
}

/** A public trade event for the trade stream. */
export interface TradeEvent {
  price: Price;
  quantity: Quantity;
  side: Side;
  ts: number;
}
