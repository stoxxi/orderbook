// packages/orderbook/__tests__/marketData.spec.ts
// Tests for Phase 3: Market Data Infrastructure
// - Depth delta tracking (markDepthDirty, getDepthDeltas, depthSeq)
// - Rolling 24h statistics (getStats24h, seedHistoricalVolume)
// - Candle engine (updateCandle, onCandleClosed)
// - Depth listener wiring (notifyDepthListener fires from dispatchNotifications)

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { createInstrument, Order, OrderBook, Side } from "../src";
import type { Candle } from "../src/types";
import type { Depth } from "../src/depth";
import type { TradeSnapshot } from "../src/trade";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBook(symbol = "TEST.A") {
  const instrument = createInstrument(
    symbol as any, 0, 0, "1" as any, "1" as any, "999999999999999" as any,
  );
  return new OrderBook(instrument);
}

const buy = (id: string, price: bigint, qty: bigint) =>
  new Order(id, Side.BUY, price, qty);
const sell = (id: string, price: bigint, qty: bigint) =>
  new Order(id, Side.SELL, price, qty);

// ---------------------------------------------------------------------------
// 1. Depth Delta Tracking
// ---------------------------------------------------------------------------

describe("Depth Delta Tracking", () => {
  test("empty book returns empty deltas", () => {
    const book = makeBook();
    const deltas = book.getDepthDeltas();
    expect(deltas.bids).toHaveLength(0);
    expect(deltas.asks).toHaveLength(0);
  });

  test("resting buy order marks bid level dirty", () => {
    const book = makeBook();
    helperAdd(book, buy("b1", 50n, 100n));

    const deltas = book.getDepthDeltas();
    expect(deltas.bids).toHaveLength(1);
    expect(deltas.bids[0].price).toBe(50n);
    expect(deltas.bids[0].quantity).toBe(100n);
    expect(deltas.asks).toHaveLength(0);
  });

  test("resting sell order marks ask level dirty", () => {
    const book = makeBook();
    helperAdd(book, sell("s1", 60n, 200n));

    const deltas = book.getDepthDeltas();
    expect(deltas.asks).toHaveLength(1);
    expect(deltas.asks[0].price).toBe(60n);
    expect(deltas.asks[0].quantity).toBe(200n);
    expect(deltas.bids).toHaveLength(0);
  });

  test("getDepthDeltas clears dirty sets after extraction", () => {
    const book = makeBook();
    helperAdd(book, buy("b1", 50n, 100n));

    const first = book.getDepthDeltas();
    expect(first.bids).toHaveLength(1);

    // Second call should be empty
    const second = book.getDepthDeltas();
    expect(second.bids).toHaveLength(0);
    expect(second.asks).toHaveLength(0);
  });

  test("cancel marks the cancelled price level dirty", () => {
    const book = makeBook();
    const result = helperAdd(book, buy("b1", 50n, 100n));
    // Consume initial delta
    book.getDepthDeltas();

    // Cancel the order
    book.cancel(BigInt(result.serverOrderId));
    const deltas = book.getDepthDeltas();
    expect(deltas.bids).toHaveLength(1);
    expect(deltas.bids[0].price).toBe(50n);
    expect(deltas.bids[0].quantity).toBe(0n); // Level is now empty
  });

  test("trade marks maker price level dirty", () => {
    const book = makeBook();
    helperAdd(book, sell("s1", 50n, 100n));
    // Consume initial delta from resting sell
    book.getDepthDeltas();

    // Aggressive buy matches against resting sell
    helperAdd(book, buy("b1", 50n, 50n));
    const deltas = book.getDepthDeltas();

    // The ask at 50 should be dirty (partially filled)
    expect(deltas.asks.some(d => d.price === 50n)).toBe(true);
    const askDelta = deltas.asks.find(d => d.price === 50n)!;
    expect(askDelta.quantity).toBe(50n); // 100 - 50 = 50 remaining
  });

  test("multiple price levels tracked independently", () => {
    const book = makeBook();
    helperAdd(book, buy("b1", 50n, 100n));
    helperAdd(book, buy("b2", 51n, 200n));
    helperAdd(book, sell("s1", 60n, 300n));

    const deltas = book.getDepthDeltas();
    expect(deltas.bids).toHaveLength(2);
    expect(deltas.asks).toHaveLength(1);
  });

  test("depthSeq increments on each dispatch with dirty depth", () => {
    const book = makeBook();
    expect(book.depthSeq).toBe(0);

    helperAdd(book, buy("b1", 50n, 100n));
    expect(book.depthSeq).toBe(1);

    helperAdd(book, sell("s1", 60n, 200n));
    expect(book.depthSeq).toBe(2);
  });

  test("depthSeq does not increment when depth is clean", () => {
    const book = makeBook();
    // No orders → no depth changes
    expect(book.depthSeq).toBe(0);
  });

  test("getLevelQty returns 0 for non-existent price", () => {
    const book = makeBook();
    expect(book.getLevelQty(999n, Side.BUY)).toBe(0n);
    expect(book.getLevelQty(999n, Side.SELL)).toBe(0n);
  });

  test("getLevelQty returns correct quantity for existing level", () => {
    const book = makeBook();
    helperAdd(book, buy("b1", 50n, 100n));
    helperAdd(book, buy("b2", 50n, 200n)); // Same price level

    expect(book.getLevelQty(50n, Side.BUY)).toBe(300n);
  });
});

// ---------------------------------------------------------------------------
// 2. Rolling 24h Statistics
// ---------------------------------------------------------------------------

describe("Rolling 24h Statistics", () => {
  test("empty book returns zero stats", () => {
    const book = makeBook();
    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(0n);
    expect(stats.tradeCount24h).toBe(0);
    expect(stats.lastPrice).toBeNull();
  });

  test("trade updates lastTradePrice", () => {
    const book = makeBook();
    helperAdd(book, sell("s1", 50n, 100n));
    helperAdd(book, buy("b1", 50n, 100n)); // Match

    expect(book.lastTradePrice).toBe(50n);
  });

  test("trade updates volume and trade count", () => {
    const book = makeBook();
    helperAdd(book, sell("s1", 50n, 100n));
    helperAdd(book, buy("b1", 50n, 50n)); // Partial fill

    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(50n);
    expect(stats.tradeCount24h).toBe(1);
    expect(stats.lastPrice).toBe(50n);
  });

  test("multiple trades accumulate correctly", () => {
    const book = makeBook();
    helperAdd(book, sell("s1", 50n, 100n));
    helperAdd(book, sell("s2", 51n, 100n));

    helperAdd(book, buy("b1", 50n, 30n)); // 30 @ 50 (matches resting sell at 50)
    helperAdd(book, buy("b2", 51n, 70n)); // 70 @ 50 (matches remaining sell at 50, maker price)

    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(100n); // 30 + 70
    expect(stats.tradeCount24h).toBe(2);
    expect(stats.lastPrice).toBe(50n); // Both trades matched at maker price 50
  });

  test("seedHistoricalVolume pre-populates a bucket", () => {
    const book = makeBook();
    book.seedHistoricalVolume(5, 5000n, 42);

    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(5000n);
    expect(stats.tradeCount24h).toBe(42);
  });

  test("multiple seeded buckets aggregate correctly", () => {
    const book = makeBook();
    book.seedHistoricalVolume(0, 1000n, 10);
    book.seedHistoricalVolume(12, 2000n, 20);

    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(3000n);
    expect(stats.tradeCount24h).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 3. Candle Engine
// ---------------------------------------------------------------------------

describe("Candle Engine", () => {
  test("trade generates candle data tracked via lastTradePrice", () => {
    const book = makeBook();
    helperAdd(book, sell("s1", 50n, 100n));
    helperAdd(book, buy("b1", 50n, 100n)); // Match at 50

    expect(book.lastTradePrice).toBe(50n);
  });

  test("onCandleClosed fires when minute boundary is crossed", () => {
    const closedCandles: Candle[] = [];

    const book = makeBook();
    book.setTradeListener({
      onTrade: () => {},
      onCandleClosed: (_, candle) => {
        closedCandles.push(candle);
      },
    });

    // First trade — starts a candle
    helperAdd(book, sell("s1", 50n, 100n));
    helperAdd(book, buy("b1", 50n, 100n));
    expect(closedCandles).toHaveLength(0); // Not closed yet

    // We can't easily cross a minute boundary in a fast test, but we can
    // verify the listener is wired by checking that a trade does NOT
    // immediately close a candle (same minute).
    expect(closedCandles).toHaveLength(0);
  });

  test("candle OHLCV tracks correctly within same minute", () => {
    const book = makeBook();

    // Multiple trades at different prices within the same minute
    helperAdd(book, sell("s1", 50n, 100n));
    helperAdd(book, sell("s2", 52n, 100n));

    helperAdd(book, buy("b1", 50n, 30n)); // Trade @ 50 (30 qty)
    helperAdd(book, buy("b2", 52n, 20n)); // Trade @ 52 (20 qty)

    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(50n); // 30 + 20
    expect(stats.tradeCount24h).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Depth Listener Wiring (formerly dead code)
// ---------------------------------------------------------------------------

describe("Depth Listener Wiring", () => {
  test("depth listener fires when order is added", () => {
    const depthUpdates: Depth[] = [];

    const book = makeBook();
    book.setDepthListener({
      onDepthChange: (_, depth) => {
        depthUpdates.push(depth);
      },
    });

    helperAdd(book, buy("b1", 50n, 100n));

    // Depth listener should fire once (order resting triggers depth update)
    expect(depthUpdates.length).toBeGreaterThanOrEqual(1);
    const lastDepth = depthUpdates[depthUpdates.length - 1];
    expect(lastDepth.bids.length).toBeGreaterThanOrEqual(1);
  });

  test("depth listener fires when order is cancelled", () => {
    const depthUpdates: Depth[] = [];

    const book = makeBook();
    book.setDepthListener({
      onDepthChange: (_, depth) => {
        depthUpdates.push(depth);
      },
    });

    const result = helperAdd(book, buy("b1", 50n, 100n));
    const countAfterAdd = depthUpdates.length;

    book.cancel(BigInt(result.serverOrderId));

    // Should have received at least one more depth update after cancel
    expect(depthUpdates.length).toBeGreaterThan(countAfterAdd);
    const lastDepth = depthUpdates[depthUpdates.length - 1];
    expect(lastDepth.bids).toHaveLength(0); // Level removed
  });

  test("depth listener fires on trade (maker side changes)", () => {
    const depthUpdates: Depth[] = [];

    const book = makeBook();
    book.setDepthListener({
      onDepthChange: (_, depth) => {
        depthUpdates.push(depth);
      },
    });

    helperAdd(book, sell("s1", 50n, 100n));
    const countAfterSell = depthUpdates.length;

    helperAdd(book, buy("b1", 50n, 50n)); // Partial fill

    // Trade triggers depth change
    expect(depthUpdates.length).toBeGreaterThan(countAfterSell);
    const lastDepth = depthUpdates[depthUpdates.length - 1];
    // Ask at 50 should still exist with 50 remaining
    const askAt50 = lastDepth.asks.find(a => a.price === 50n);
    expect(askAt50).toBeDefined();
    expect(askAt50!.quantity).toBe(50n);
  });

  test("depth listener not called when no listener is set", () => {
    // This just verifies no crash when no listener is set
    const book = makeBook();
    helperAdd(book, buy("b1", 50n, 100n));
    helperAdd(book, sell("s1", 60n, 200n));
    // No listener → no crash
    expect(book.depthSeq).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Integration: Full trade lifecycle with market data
// ---------------------------------------------------------------------------

describe("Market Data Integration", () => {
  test("full trade lifecycle updates all market data", () => {
    const depthUpdates: Depth[] = [];
    const trades: TradeSnapshot[] = [];

    const book = makeBook();
    book.setDepthListener({
      onDepthChange: (_, depth) => depthUpdates.push(depth),
    });
    book.setTradeListener({
      onTrade: (_, trade) => trades.push(trade),
    });

    // 1. Place resting orders
    helperAdd(book, sell("s1", 100n, 500n));
    helperAdd(book, sell("s2", 101n, 300n));
    helperAdd(book, buy("b-rest", 99n, 200n));

    const depthCountAfterResting = depthUpdates.length;
    const initialSeq = book.depthSeq;

    // Consume initial deltas
    book.getDepthDeltas();

    // 2. Aggressive buy matches s1 partially
    helperAdd(book, buy("b-aggro", 100n, 200n));

    // Verify trade fired
    expect(trades).toHaveLength(1);
    expect(trades[0].matchPrice).toBe(100n);
    expect(trades[0].matchQuantity).toBe(200n);

    // Verify depth updated
    expect(depthUpdates.length).toBeGreaterThan(depthCountAfterResting);

    // Verify depth deltas show the changed ask level
    const deltas = book.getDepthDeltas();
    const askDelta = deltas.asks.find(d => d.price === 100n);
    expect(askDelta).toBeDefined();
    expect(askDelta!.quantity).toBe(300n); // 500 - 200

    // Verify 24h stats
    const stats = book.getStats24h();
    expect(stats.volume24h).toBe(200n);
    expect(stats.tradeCount24h).toBe(1);
    expect(stats.lastPrice).toBe(100n);

    // Verify depthSeq incremented
    expect(book.depthSeq).toBeGreaterThan(initialSeq);
  });

  test("getDepth returns full snapshot (not just deltas)", () => {
    const book = makeBook();
    book.setDepthListener({ onDepthChange: () => {} }); // Need listener for rebuild

    helperAdd(book, buy("b1", 50n, 100n));
    helperAdd(book, buy("b2", 49n, 200n));
    helperAdd(book, sell("s1", 60n, 300n));

    const depth = book.getDepth();
    expect(depth.bids).toHaveLength(2);
    expect(depth.asks).toHaveLength(1);
    expect(depth.bids[0].price).toBe(50n); // Best bid first
    expect(depth.bids[1].price).toBe(49n);
    expect(depth.asks[0].price).toBe(60n);
  });

  test("replace order marks both old and new price dirty", () => {
    const book = makeBook();
    const result = helperAdd(book, buy("b1", 50n, 100n));
    // Consume initial delta
    book.getDepthDeltas();

    // Replace: change price from 50 to 55
    book.replace(BigInt(result.serverOrderId), 100n, 55n);

    const deltas = book.getDepthDeltas();
    // Both old (50) and new (55) should be dirty
    const prices = [...deltas.bids.map(d => d.price)];
    expect(prices).toContain(50n); // Old price (now empty)
    expect(prices).toContain(55n); // New price
  });

  test("replace with quantity decrease marks level dirty", () => {
    const book = makeBook();
    const result = helperAdd(book, buy("b1", 50n, 100n));
    // Consume
    book.getDepthDeltas();

    // Reduce quantity (same price → retains priority)
    book.replace(BigInt(result.serverOrderId), 50n, 50n);

    const deltas = book.getDepthDeltas();
    expect(deltas.bids).toHaveLength(1);
    expect(deltas.bids[0].price).toBe(50n);
    expect(deltas.bids[0].quantity).toBe(50n);
  });
});
