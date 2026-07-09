// packages/orderbook/src/serialization.ts
//
// Guards for the untrusted serialization / wire trust boundary. Snapshots, WAL
// records, and wire trade records may transit disk or network before reaching
// this pure-matching package, so every raw numeric string is length-capped
// BEFORE `BigInt()` conversion: decimal→BigInt is subquadratic, so an unbounded
// digit string is a single-threaded-venue DoS (a ~300 KB field measured at
// ~700 ms of matching-thread stall). The cap dwarfs every legitimate value — a
// scaled price/quantity is ≤ 18 digits (MAX_SYSTEM_VAL = 10^18 − 1) and the
// largest derived field, `cumulativeQuoteValue = Σ(price × quantity)`, is
// ≤ ~37 digits — while keeping the parse in the nanosecond range.

import { FatalEngineError } from "./errors";

/**
 * Maximum character length of a serialized numeric string accepted before
 * `BigInt()` conversion. 80 leaves ~2× headroom over the largest legitimate
 * field (~37-digit `cumulativeQuoteValue`) yet is orders of magnitude below the
 * length at which decimal→BigInt parsing becomes a denial-of-service.
 */
export const MAX_SERIALIZED_DIGITS = 80;

/**
 * Length-bounded {@link BigInt} for untrusted serialized fields.
 *
 * Rejects a non-string or over-long input with a {@link FatalEngineError}
 * *before* conversion (the DoS guard), then delegates to `BigInt()` — which
 * still throws on non-numeric input exactly as the unguarded call did.
 *
 * @param value Raw decimal string from a snapshot / WAL / wire record.
 * @param field Field name, surfaced in the error for 3am-oncall triage.
 * @returns The parsed `bigint`.
 * @throws {FatalEngineError} if `value` is not a string or exceeds
 *   {@link MAX_SERIALIZED_DIGITS} characters.
 *
 * @remarks
 * This is the length/DoS bound only; callers still apply their own semantic
 * range checks (e.g. `≤ MAX_PRICE_VALUE`) where a field has one.
 */
export function toBoundedBigInt(value: string, field: string): bigint {
  if (typeof value !== "string") {
    throw new FatalEngineError(
      `Serialized field '${field}' must be a string, got ${typeof value}`,
      { field, valueType: typeof value, path: "serialization.toBoundedBigInt" },
    );
  }
  if (value.length > MAX_SERIALIZED_DIGITS) {
    throw new FatalEngineError(
      `Serialized field '${field}' is ${value.length} chars, exceeds the ` +
        `${MAX_SERIALIZED_DIGITS}-char cap (BigInt-parse DoS guard)`,
      { field, length: value.length, cap: MAX_SERIALIZED_DIGITS, path: "serialization.toBoundedBigInt" },
    );
  }
  return BigInt(value);
}
