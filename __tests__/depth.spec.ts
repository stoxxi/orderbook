// packages/orderbook/__tests__/depth.spec.ts

import { beforeEach, describe, expect, it } from "bun:test";
import { Depth, DepthLevel } from "../src/depth";
import { parseToInternal, toCanonicalDecimal } from "../src/instrument";
import { Price } from "../src/types";

// =============================================================================
// TEST HELPER UTILITY
// =============================================================================
const testToInternalPrice = (displayPrice: number | string, precision = 2): Price => {
  return parseToInternal(toCanonicalDecimal(String(displayPrice), precision), precision) as Price;
};

describe("Depth", () => {
  let depth: Depth;

  beforeEach(() => {
    depth = new Depth();
  });

  describe("Initialization and State", () => {
    it("should be initialized with empty bids and asks arrays", () => {
      expect(depth.bids).toBeInstanceOf(Array);
      expect(depth.asks).toBeInstanceOf(Array);
      expect(depth.bids).toHaveLength(0);
      expect(depth.asks).toHaveLength(0);
      expect(depth.lastChange).toBe(0);
    });

    it("should clear all bid and ask levels correctly", () => {
      depth.addBidLevel({
        price: testToInternalPrice(100),
        quantity: 50n,
        orderCount: 1,
      });
      depth.addAskLevel({
        price: testToInternalPrice(101),
        quantity: 75n,
        orderCount: 2,
      });
      depth.clear();
      expect(depth.bids).toEqual([]);
      expect(depth.asks).toEqual([]);
    });
  });

  describe("Adding Depth Levels", () => {
    it("should add a single bid level correctly", () => {
      const level: DepthLevel = {
        price: testToInternalPrice(100.5),
        quantity: 50n,
        orderCount: 1,
      };
      depth.addBidLevel(level);
      expect(depth.bids).toHaveLength(1);
      expect(depth.bids[0]).toEqual(level);
    });

    it("should add a single ask level correctly", () => {
      const level: DepthLevel = {
        price: testToInternalPrice(101.25),
        quantity: 75n,
        orderCount: 2,
      };
      depth.addAskLevel(level);
      expect(depth.asks).toHaveLength(1);
      expect(depth.asks[0]).toEqual(level);
    });
  });

  describe("Cloning", () => {
    beforeEach(() => {
      depth.addBidLevel({ price: 10000n, quantity: 10n, orderCount: 1 });
      depth.addAskLevel({ price: 10100n, quantity: 20n, orderCount: 2 });
      depth.lastChange = 1234567890;
    });

    it("should create a clone with identical bid, ask levels, and lastChange", () => {
      const clone = depth.shallowClone();
      expect(clone.bids).toEqual(depth.bids);
      expect(clone.asks).toEqual(depth.asks);
      expect(clone.lastChange).toBe(depth.lastChange);
    });

    it("should create a deep copy of the arrays, not a reference", () => {
      const clone = depth.shallowClone();
      expect(clone.bids).not.toBe(depth.bids);
      expect(clone.asks).not.toBe(depth.asks);
    });

    it("should ensure that modifying the clone does not affect the original", () => {
      const clone = depth.shallowClone();
      clone.addBidLevel({ price: 9900n, quantity: 5n, orderCount: 1 });
      clone.clear();
      expect(depth.bids).toHaveLength(1);
      expect(depth.asks).toHaveLength(1);
      expect(depth.bids[0].price).toBe(10000n);
    });

    it("should ensure that modifying the original does not affect a previously created clone", () => {
      const clone = depth.shallowClone();
      depth.addAskLevel({ price: 10200n, quantity: 30n, orderCount: 3 });
      depth.lastChange = Date.now();
      expect(clone.asks).toHaveLength(1);
      expect(clone.asks[0].price).toBe(10100n);
      expect(clone.lastChange).toBe(1234567890);
    });
  });
});
