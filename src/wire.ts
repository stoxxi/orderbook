// packages/orderbook/src/wire.ts

import { MAX_PRICE_VALUE, MAX_QUANTITY_VALUE } from "./constants";
import { MAX_SERIALIZED_DIGITS } from "./serialization";
import { TradeSnapshot } from "./trade";

/** JSON-friendly wire shape where bigints are strings */
export interface WireTradeSnapshot {
  readonly matchPrice: string;
  readonly matchQuantity: string;
  readonly makingOrderId: string;
  readonly takingOrderId: string;
  readonly tradeId: string;
}

/**
 * Helper to convert snapshot -> wire.
 *
 * @remarks
 * This mapping intentionally mirrors `Trade.toWire()` in `src/trade.ts`. They
 * are kept separate on purpose — `Trade.toWire()` serializes a live pooled
 * `Trade` instance directly (no snapshot allocation on that path), while this
 * takes an already-immutable `TradeSnapshot`. If `WireTradeSnapshot` gains a
 * field, update both serializers together.
 */
export function tradeSnapshotToWire(t: TradeSnapshot): WireTradeSnapshot {
  return {
    matchPrice: t.matchPrice.toString(),
    matchQuantity: t.matchQuantity.toString(),
    makingOrderId: t.makingOrderId,
    takingOrderId: t.takingOrderId,
    tradeId: t.tradeId.toString(),
  };
}

/**
 * Helper to parse wire -> snapshot.
 *
 * Validates the untrusted string fields before conversion. `BigInt()` already
 * throws loudly on non-numeric price/quantity, but `parseInt` did NOT — it
 * silently accepted `"12abc" -> 12` and produced `NaN` on empty/garbage input,
 * yielding a plausible-but-wrong TradeId. We now reject non-canonical integer
 * ids and negative magnitudes so a corrupted wire record fails fast instead of
 * flowing a bad trade id / negative fill downstream.
 */
export function wireToTradeSnapshot(w: WireTradeSnapshot): TradeSnapshot {
  if (!/^\d+$/.test(w.tradeId)) {
    throw new TypeError(
      `wireToTradeSnapshot: invalid tradeId "${w.tradeId}" (expected a non-negative integer string)`,
    );
  }
  const tradeId = Number(w.tradeId);
  if (!Number.isSafeInteger(tradeId)) {
    throw new TypeError(`wireToTradeSnapshot: tradeId "${w.tradeId}" exceeds MAX_SAFE_INTEGER`);
  }
  // Untrusted wire input: length-cap the raw digit strings BEFORE BigInt().
  // Decimal→BigInt is subquadratic, so an unbounded string stalls the
  // single-threaded venue (see serialization.ts).
  //
  // This guard deliberately does NOT delegate to `toBoundedBigInt`: that helper
  // throws `FatalEngineError` (meaning "halt the engine"), which is the right
  // response to a corrupt *snapshot* on restore, but the WRONG response to a
  // malformed *wire* record — external, network-reachable input should be
  // REJECTED (`TypeError`), not halt the venue. The shared threshold
  // (`MAX_SERIALIZED_DIGITS`) is imported, so the cap can't drift; only the
  // trap error type differs, on purpose.
  for (const [name, raw] of [
    ["matchPrice", w.matchPrice],
    ["matchQuantity", w.matchQuantity],
  ] as const) {
    if (typeof raw !== "string" || raw.length > MAX_SERIALIZED_DIGITS) {
      throw new TypeError(
        `wireToTradeSnapshot: ${name} exceeds ${MAX_SERIALIZED_DIGITS}-char cap (DoS guard)`,
      );
    }
  }
  const matchPrice = BigInt(w.matchPrice); // throws on non-numeric
  const matchQuantity = BigInt(w.matchQuantity); // throws on non-numeric
  if (matchPrice < 0n || matchQuantity < 0n) {
    throw new TypeError(
      `wireToTradeSnapshot: negative price/quantity (price=${w.matchPrice}, quantity=${w.matchQuantity})`,
    );
  }
  // Magnitude ceiling — parity with the order path, which bounds price/quantity
  // to the system maximum. A wire record whose magnitude exceeds it is corrupt.
  if (matchPrice > MAX_PRICE_VALUE || matchQuantity > MAX_QUANTITY_VALUE) {
    throw new TypeError(
      `wireToTradeSnapshot: price/quantity exceeds system maximum ` +
        `(price=${w.matchPrice}, quantity=${w.matchQuantity})`,
    );
  }
  return {
    matchPrice,
    matchQuantity,
    makingOrderId: w.makingOrderId,
    takingOrderId: w.takingOrderId,
    tradeId,
  };
}
