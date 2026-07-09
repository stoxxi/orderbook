// tests/tradePool.spec.ts

import { beforeEach, describe, expect, it } from "bun:test";
import { Order } from "../src/order";
import { Trade } from "../src/trade";
import { TradePool } from "../src/tradePool"; // Import the class
import { Side } from "../src/types";

describe("TradePool", () => {
  let tradePool: TradePool;
  const maker = new Order("maker", Side.BUY, 100n, 10n);
  const taker = new Order("taker", Side.SELL, 100n, 10n);

  // Create a new pool with a small capacity for each test
  beforeEach(() => {
    tradePool = new TradePool(2); // Set capacity to 2 for these tests
  });

  it("should create a new Trade object when the pool is empty", () => {
    const trade = tradePool.get(maker, taker, 10n, 100n, 1);
    expect(trade).toBeInstanceOf(Trade);
    expect(trade.tradeId).toBe(1);
    expect(tradePool.getPoolStats()).toMatchObject({
      size: 0,
      misses: 1,
      hits: 0,
    });
  });

  it("should reuse a Trade object from the pool", () => {
    const trade1 = tradePool.get(maker, taker, 10n, 100n, 1);
    tradePool.release(trade1);
    expect(tradePool.getPoolStats().size).toBe(1);

    const trade2 = tradePool.get(maker, taker, 5n, 101n, 2);
    expect(trade2).toBe(trade1); // Should be the same instance
    expect(trade2.tradeId).toBe(2);
    expect(trade2.matchQuantity).toBe(5n);
    expect(tradePool.getPoolStats()).toMatchObject({
      size: 0,
      misses: 1,
      hits: 1,
    });
  });

  it("should not add objects to the pool if it is at capacity", () => {
    const trade1 = tradePool.get(maker, taker, 1n, 1n, 1);
    const trade2 = tradePool.get(maker, taker, 2n, 2n, 2);
    const trade3 = tradePool.get(maker, taker, 3n, 3n, 3);

    // Release all three, but the pool capacity is 2
    tradePool.release(trade1);
    tradePool.release(trade2);
    tradePool.release(trade3);

    expect(tradePool.getPoolStats().size).toBe(2);
  });

  it("should create a new object if a get is requested when the pool is empty", () => {
    const trade1 = tradePool.get(maker, taker, 1n, 1n, 1);
    const trade2 = tradePool.get(maker, taker, 2n, 2n, 2);
    tradePool.release(trade1);
    tradePool.release(trade2);
    expect(tradePool.getPoolStats().size).toBe(2);

    // These gets should reuse objects
    const reusedTrade1 = tradePool.get(maker, taker, 3n, 3n, 3);
    const reusedTrade2 = tradePool.get(maker, taker, 4n, 4n, 4);
    expect(tradePool.getPoolStats().size).toBe(0);

    // The pool is now empty, so this get must create a new instance
    const trade5 = tradePool.get(maker, taker, 5n, 5n, 5);
    expect(trade5).not.toBe(reusedTrade1);
    expect(trade5).not.toBe(reusedTrade2);
    expect(tradePool.getPoolStats()).toMatchObject({
      size: 0,
      misses: 3,
      hits: 2,
    });
  });

  it("should correctly report hit rate", () => {
    // 3 misses
    tradePool.get(maker, taker, 1n, 1n, 1);
    const t2 = tradePool.get(maker, taker, 2n, 2n, 2);
    const t3 = tradePool.get(maker, taker, 3n, 3n, 3);

    // 2 hits
    tradePool.release(t2);
    tradePool.release(t3);
    tradePool.get(maker, taker, 4n, 4n, 4);
    tradePool.get(maker, taker, 5n, 5n, 5);

    const stats = tradePool.getPoolStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(3);
    expect(stats.hitRate).toBe(2 / 5); // 0.4
  });
});
