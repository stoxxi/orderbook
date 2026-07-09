// packages/orderbook/__tests__/wire.spec.ts
// P3: Wire Format Serialization Tests
//
// Tests for trade snapshot serialization to/from JSON-safe wire format.
// Ensures bigint values are correctly converted for network transmission.

import { describe, test, expect } from "bun:test";
import {
  tradeSnapshotToWire,
  wireToTradeSnapshot,
  type WireTradeSnapshot,
} from "../src/wire";
import type { TradeSnapshot } from "../src/trade";

describe("Wire Format Serialization", () => {
  describe("tradeSnapshotToWire", () => {
    test("should convert TradeSnapshot to WireTradeSnapshot", () => {
      const snapshot: TradeSnapshot = {
        matchPrice: 10050n,
        matchQuantity: 500n,
        makingOrderId: "maker-123",
        takingOrderId: "taker-456",
        tradeId: 789,
      };

      const wire = tradeSnapshotToWire(snapshot);

      expect(wire.matchPrice).toBe("10050");
      expect(wire.matchQuantity).toBe("500");
      expect(wire.makingOrderId).toBe("maker-123");
      expect(wire.takingOrderId).toBe("taker-456");
      expect(wire.tradeId).toBe("789");
    });

    test("should convert large bigint values", () => {
      const snapshot: TradeSnapshot = {
        matchPrice: 999999999999999999n,
        matchQuantity: 123456789012345678n,
        makingOrderId: "m1",
        takingOrderId: "t1",
        tradeId: 999999999,
      };

      const wire = tradeSnapshotToWire(snapshot);

      expect(wire.matchPrice).toBe("999999999999999999");
      expect(wire.matchQuantity).toBe("123456789012345678");
    });

    test("should convert zero values", () => {
      const snapshot: TradeSnapshot = {
        matchPrice: 0n,
        matchQuantity: 0n,
        makingOrderId: "",
        takingOrderId: "",
        tradeId: 0,
      };

      const wire = tradeSnapshotToWire(snapshot);

      expect(wire.matchPrice).toBe("0");
      expect(wire.matchQuantity).toBe("0");
      expect(wire.tradeId).toBe("0");
    });

    test("should preserve string fields as-is", () => {
      const snapshot: TradeSnapshot = {
        matchPrice: 100n,
        matchQuantity: 50n,
        makingOrderId: "special-chars-!@#$%",
        takingOrderId: "unicode-测试-🎉",
        tradeId: 1,
      };

      const wire = tradeSnapshotToWire(snapshot);

      expect(wire.makingOrderId).toBe("special-chars-!@#$%");
      expect(wire.takingOrderId).toBe("unicode-测试-🎉");
    });
  });

  describe("wireToTradeSnapshot", () => {
    test("should convert WireTradeSnapshot to TradeSnapshot", () => {
      const wire: WireTradeSnapshot = {
        matchPrice: "10050",
        matchQuantity: "500",
        makingOrderId: "maker-123",
        takingOrderId: "taker-456",
        tradeId: "789",
      };

      const snapshot = wireToTradeSnapshot(wire);

      expect(snapshot.matchPrice).toBe(10050n);
      expect(snapshot.matchQuantity).toBe(500n);
      expect(snapshot.makingOrderId).toBe("maker-123");
      expect(snapshot.takingOrderId).toBe("taker-456");
      expect(snapshot.tradeId).toBe(789);
    });

    test("should convert large string values to bigint", () => {
      const wire: WireTradeSnapshot = {
        matchPrice: "999999999999999999",
        matchQuantity: "123456789012345678",
        makingOrderId: "m1",
        takingOrderId: "t1",
        tradeId: "999999999",
      };

      const snapshot = wireToTradeSnapshot(wire);

      expect(snapshot.matchPrice).toBe(999999999999999999n);
      expect(snapshot.matchQuantity).toBe(123456789012345678n);
      expect(snapshot.tradeId).toBe(999999999);
    });

    test("should convert zero string values", () => {
      const wire: WireTradeSnapshot = {
        matchPrice: "0",
        matchQuantity: "0",
        makingOrderId: "",
        takingOrderId: "",
        tradeId: "0",
      };

      const snapshot = wireToTradeSnapshot(wire);

      expect(snapshot.matchPrice).toBe(0n);
      expect(snapshot.matchQuantity).toBe(0n);
      expect(snapshot.tradeId).toBe(0);
    });
  });

  describe("Roundtrip Consistency", () => {
    test("should maintain data integrity through roundtrip", () => {
      const original: TradeSnapshot = {
        matchPrice: 12345n,
        matchQuantity: 67890n,
        makingOrderId: "maker-abc",
        takingOrderId: "taker-xyz",
        tradeId: 42,
      };

      const wire = tradeSnapshotToWire(original);
      const restored = wireToTradeSnapshot(wire);

      expect(restored.matchPrice).toBe(original.matchPrice);
      expect(restored.matchQuantity).toBe(original.matchQuantity);
      expect(restored.makingOrderId).toBe(original.makingOrderId);
      expect(restored.takingOrderId).toBe(original.takingOrderId);
      expect(restored.tradeId).toBe(original.tradeId);
    });

    test("should maintain integrity for edge case values", () => {
      const original: TradeSnapshot = {
        matchPrice: 1n, // Minimum positive
        matchQuantity: 9007199254740991n, // MAX_SAFE_INTEGER as bigint
        makingOrderId: "a",
        takingOrderId: "b",
        tradeId: 1,
      };

      const wire = tradeSnapshotToWire(original);
      const restored = wireToTradeSnapshot(wire);

      expect(restored.matchPrice).toBe(original.matchPrice);
      expect(restored.matchQuantity).toBe(original.matchQuantity);
    });

    test("should maintain integrity for values beyond MAX_SAFE_INTEGER", () => {
      // Values that would lose precision with Number
      const original: TradeSnapshot = {
        matchPrice: 9007199254740993n, // MAX_SAFE_INTEGER + 2
        matchQuantity: 18014398509481984n, // 2^54
        makingOrderId: "m",
        takingOrderId: "t",
        tradeId: 100,
      };

      const wire = tradeSnapshotToWire(original);
      const restored = wireToTradeSnapshot(wire);

      // These would fail if using Number conversion
      expect(restored.matchPrice).toBe(9007199254740993n);
      expect(restored.matchQuantity).toBe(18014398509481984n);
    });
  });

  describe("JSON Serialization", () => {
    test("wire format should be JSON serializable", () => {
      const snapshot: TradeSnapshot = {
        matchPrice: 10050n,
        matchQuantity: 500n,
        makingOrderId: "maker",
        takingOrderId: "taker",
        tradeId: 123,
      };

      const wire = tradeSnapshotToWire(snapshot);
      const json = JSON.stringify(wire);
      const parsed = JSON.parse(json);

      expect(parsed.matchPrice).toBe("10050");
      expect(parsed.matchQuantity).toBe("500");
      expect(typeof parsed.matchPrice).toBe("string");
    });

    test("should roundtrip through JSON correctly", () => {
      const original: TradeSnapshot = {
        matchPrice: 999999999999n,
        matchQuantity: 888888888888n,
        makingOrderId: "m1",
        takingOrderId: "t1",
        tradeId: 999,
      };

      // Full roundtrip: snapshot -> wire -> JSON -> parse -> snapshot
      const wire = tradeSnapshotToWire(original);
      const json = JSON.stringify(wire);
      const parsed: WireTradeSnapshot = JSON.parse(json);
      const restored = wireToTradeSnapshot(parsed);

      expect(restored.matchPrice).toBe(original.matchPrice);
      expect(restored.matchQuantity).toBe(original.matchQuantity);
      expect(restored.tradeId).toBe(original.tradeId);
    });
  });
});
