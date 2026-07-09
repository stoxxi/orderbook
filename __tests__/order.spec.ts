// packages/orderbook/__tests__/order.spec.ts

import { describe, expect, it } from "bun:test";
import { parseToInternal, toCanonicalDecimal } from "../src/instrument";
import { deserializeOrder, Order, OrderState } from "../src/order";
import { Price, Quantity, Side } from "../src/types";

// =============================================================================
// TEST HELPER UTILITIES
// =============================================================================
const testToInternalPrice = (displayPrice: number | string, precision = 2): Price => {
  return parseToInternal(toCanonicalDecimal(String(displayPrice), precision), precision) as Price;
};

const testToInternalQuantity = (displayQuantity: number | string, precision = 0): Quantity => {
  const qtyStr = String(displayQuantity);
  const parts = qtyStr.split(".");
  const whole = parts[0];
  const fraction = (parts[1] || "").padEnd(precision, "0");
  return BigInt(whole + fraction);
};

describe("Order", () => {
  describe("Initialization and Properties", () => {
    it("should be initialized correctly with all properties", () => {
      const price = testToInternalPrice("150.25");
      const quantity = testToInternalQuantity("100");
      const userData = { userId: "user123", strategy: "momentum" };

      const order = new Order("client-order-1", Side.BUY, price, quantity, userData);

      expect(order.orderId).toBe("client-order-1");
      expect(order.side).toBe(Side.BUY);
      expect(order.price).toBe(15025n);
      expect(order.orderQuantity).toBe(100n);
      expect(order.openQuantity).toBe(100n);
      expect(order.serverOrderId).toBeNull();
      expect(order.state).toBe(OrderState.PENDING_NEW);
      expect(order.userData).toEqual(userData);
    });

    it("should throw when order has zero quantity", () => {
      expect(() => new Order("order-zero-qty", Side.BUY, 10000n, 0n)).toThrow(
        /Quantity must be positive/,
      );
    });
  });

  describe("Quantity Management", () => {
    it("should decrease the open quantity correctly on a partial fill", () => {
      const order = new Order("order-partial", Side.SELL, 5000n, 50n);
      order.decreaseQuantity(20n);
      expect(order.openQuantity).toBe(30n);
      expect(order.isFilled()).toBe(false);
    });

    it("should mark the order as filled when open quantity becomes exactly zero", () => {
      const order = new Order("order-full", Side.BUY, 9900n, 75n);
      order.decreaseQuantity(75n);
      expect(order.openQuantity).toBe(0n);
      expect(order.isFilled()).toBe(true);
    });

    it("should clamp open quantity to zero when over-filled", () => {
      const order = new Order("order-overfill", Side.SELL, 1000n, 40n);
      order.decreaseQuantity(50n);
      expect(order.openQuantity).toBe(0n);
      expect(order.isFilled()).toBe(true);
    });

    it("should throw an error when attempting to decrease by a negative number", () => {
      const order = new Order("order-neg-decrease", Side.BUY, 1000n, 40n);
      const action = () => order.decreaseQuantity(-10n);
      expect(action).toThrow("Quantity to decrease cannot be negative.");
      expect(order.openQuantity).toBe(40n);
    });
  });

  describe("Order Type Classification", () => {
    it("should correctly identify a limit order (price > 0)", () => {
      const limitOrder = new Order("limit-1", Side.BUY, 1n, 100n);
      expect(limitOrder.isLimit()).toBe(true);
      expect(limitOrder.isMarket()).toBe(false);
    });

    it("should correctly identify a market order (price === 0)", () => {
      const marketOrder = new Order("market-1", Side.BUY, 0n, 100n);
      expect(marketOrder.isLimit()).toBe(false);
      expect(marketOrder.isMarket()).toBe(true);
    });

    // #398: marketable-limit IOC — a priced LIMIT order tagged IOC must report
    // isIOC() so OrderBook cancels its residual instead of resting it.
    it("a priced LIMIT order with ioc=true is IOC (residual will be canceled)", () => {
      const o = new Order("ioc-1", Side.BUY, 100n, 50n);
      expect(o.isMarket()).toBe(false); // still a limit (price > 0)
      expect(o.isIOC()).toBe(false); // default GTC
      o.ioc = true;
      expect(o.isIOC()).toBe(true); // now IOC despite being a priced limit
    });

    it("a plain limit order (no flags) is not IOC (rests GTC)", () => {
      const o = new Order("gtc-1", Side.SELL, 200n, 10n);
      expect(o.isIOC()).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Serialization / deserialization
  //
  // Regression guard for the snapshot BigInt bug. Previously toSerializableObject
  // only stringified 4 of 6 BigInt fields (price, orderQuantity, openQuantity,
  // serverOrderId) and missed cumulativeFilledQuantity + cumulativeQuoteValue.
  // JSON.stringify() then threw "cannot serialize BigInt" on every snapshot
  // write, silently preventing any snapshot from ever being persisted. Engine
  // restarts fell back to full WAL replay, producing ghost orders for
  // cancel/replace-heavy sequences.
  //
  // The contract these tests lock in:
  //   (1) toSerializableObject() must NEVER contain a BigInt (JSON-safe)
  //   (2) JSON.stringify() must not throw on the result
  //   (3) deserializeOrder(toSerializableObject(order)) must reconstruct an
  //       equivalent Order (identity round-trip)
  //   (4) null serverOrderId must survive the round-trip as null (no
  //       ".toString() on null" throw, no coercion to undefined/"null")
  // ───────────────────────────────────────────────────────────────────────────
  describe("Serialization round-trip", () => {
    it("toSerializableObject() contains no BigInt values — all stringified", () => {
      const order = new Order("coid-rt-1", Side.BUY, 15025n, 100n, { userId: "u1" });
      order.serverOrderId = 42n as OrderState extends never ? never : bigint as any;
      order.decreaseQuantity(30n);
      order.cumulativeFilledQuantity = 30n;
      order.cumulativeQuoteValue = 450750n;

      const serialized = order.toSerializableObject();
      for (const [key, value] of Object.entries(serialized)) {
        expect(typeof value).not.toBe("bigint");
        // Explicit helpful message if this fails in the future
        if (typeof value === "bigint") {
          throw new Error(`toSerializableObject leaked BigInt on field '${key}'`);
        }
      }
    });

    it("JSON.stringify(toSerializableObject()) must not throw — primary bug repro", () => {
      const order = new Order("coid-rt-2", Side.SELL, 25000n, 50n, { userId: "u2" });
      order.serverOrderId = 7n as any;
      order.decreaseQuantity(20n);
      order.cumulativeFilledQuantity = 20n;
      order.cumulativeQuoteValue = 500000n;

      // Before the fix, this specifically threw: "TypeError: JSON.stringify
      // cannot serialize BigInt." Keep this exact call pattern as the
      // canonical regression trigger.
      expect(() => JSON.stringify(order.toSerializableObject())).not.toThrow();

      const json = JSON.stringify(order.toSerializableObject());
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(parsed.orderId).toBe("coid-rt-2");
      expect(parsed.price).toBe("25000");
      expect(parsed.orderQuantity).toBe("50");
      expect(parsed.openQuantity).toBe("30");
      expect(parsed.cumulativeFilledQuantity).toBe("20");
      expect(parsed.cumulativeQuoteValue).toBe("500000");
    });

    it("deserializeOrder restores all BigInt fields identically", () => {
      const original = new Order("coid-rt-3", Side.BUY, 12345n, 200n, { userId: "u3" });
      original.serverOrderId = 99n as any;
      original.decreaseQuantity(75n);
      original.cumulativeFilledQuantity = 75n;
      original.cumulativeQuoteValue = 925875n;
      original.state = OrderState.PARTIALLY_FILLED;

      const json = JSON.stringify(original.toSerializableObject());
      const restored = deserializeOrder<{ userId: string }>(JSON.parse(json));

      expect(restored.orderId).toBe(original.orderId);
      expect(restored.side).toBe(original.side);
      expect(restored.price).toBe(original.price);
      expect(restored.orderQuantity).toBe(original.orderQuantity);
      expect(restored.openQuantity).toBe(original.openQuantity);
      expect(restored.serverOrderId).toBe(original.serverOrderId);
      expect(restored.state).toBe(original.state);
      // Fill tracking must survive — previously dropped on import, causing
      // partially-filled orders to come back with filled=0 on restart.
      expect(restored.cumulativeFilledQuantity).toBe(original.cumulativeFilledQuantity);
      expect(restored.cumulativeQuoteValue).toBe(original.cumulativeQuoteValue);
      expect(restored.isProtectedMarket).toBe(original.isProtectedMarket);
      expect(restored.userData).toEqual(original.userData);
    });

    // #398: the IOC flag round-trips, and absent (pre-#398) snapshots restore
    // as false (GTC) without throwing — IOC orders never rest, so a snapshotted
    // resting order is always GTC.
    it("ioc flag round-trips; absent ioc restores as false (back-compat)", () => {
      const ioc = new Order("ioc-rt", Side.BUY, 100n, 50n, { userId: "u" });
      ioc.ioc = true;
      const restored = deserializeOrder<{ userId: string }>(JSON.parse(JSON.stringify(ioc.toSerializableObject())));
      expect(restored.ioc).toBe(true);
      expect(restored.isIOC()).toBe(true);

      // Simulate a pre-#398 snapshot (no ioc field): must default to false, not throw.
      const legacy = ioc.toSerializableObject();
      delete (legacy as Record<string, unknown>).ioc;
      const legacyRestored = deserializeOrder<{ userId: string }>(JSON.parse(JSON.stringify(legacy)));
      expect(legacyRestored.ioc).toBe(false);
      expect(legacyRestored.isIOC()).toBe(false);
    });

    it("clone() copies the ioc flag (Step-2 sandbox parity)", () => {
      const o = new Order("ioc-clone", Side.BUY, 100n, 50n, { userId: "u" });
      o.ioc = true;
      expect(o.clone().ioc).toBe(true);
    });

    it("null serverOrderId round-trips as null (no .toString() on null)", () => {
      // Orders exist in memory before the book assigns a serverOrderId.
      // The serialized form must preserve null so the reconstructed order
      // stays assignable-later instead of silently becoming 0n or "null".
      const order = new Order("coid-rt-null", Side.BUY, 10000n, 10n, { userId: "u4" });
      expect(order.serverOrderId).toBeNull();

      const serialized = order.toSerializableObject();
      expect(serialized.serverOrderId).toBeNull();
      expect(() => JSON.stringify(serialized)).not.toThrow();

      const json = JSON.stringify(serialized);
      expect(JSON.parse(json).serverOrderId).toBeNull();

      const restored = deserializeOrder<{ userId: string }>(JSON.parse(json));
      expect(restored.serverOrderId).toBeNull();
    });

    it("zero-valued BigInt fields survive the round-trip as 0n", () => {
      // Edge case: a freshly-created order has cumulativeFilledQuantity=0n and
      // cumulativeQuoteValue=0n. Those stringify to "0" which BigInt("0")
      // parses back to 0n — must not become undefined or skipped.
      const order = new Order("coid-rt-zero", Side.BUY, 500n, 25n);
      expect(order.cumulativeFilledQuantity).toBe(0n);
      expect(order.cumulativeQuoteValue).toBe(0n);

      const json = JSON.stringify(order.toSerializableObject());
      const restored = deserializeOrder(JSON.parse(json));
      expect(restored.cumulativeFilledQuantity).toBe(0n);
      expect(restored.cumulativeQuoteValue).toBe(0n);
    });
  });
});
