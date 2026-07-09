// packages/orderbook/__tests__/ob-d3-03-candle-snapshot.spec.ts
//
// OB-D3-03: the 24h ticker buckets (volumeBuckets/tradeCountBuckets/
// lastUpdateHour) and the in-progress candle (currentCandle) must survive an
// exportSnapshot -> importSnapshot round-trip. Before the fix they were absent
// from OrderBookSnapshotData, so a snapshot-based restart reset 24h volume to
// ~0 (closed candles persist via the Event WAL KLINE_CLOSED, but the live
// ticker + in-progress candle did not). These fields are additive + optional,
// so old snapshots still load (buckets default to empty).

import { describe, expect, test } from "bun:test";
import { helperAdd, helperSyncAfterImport } from "./_helpers";
import { createInstrument, Order, OrderBook, Side } from "../src";

function makeBook(symbol = "TEST.A") {
  const instrument = createInstrument(
    symbol as any, 0, 0, "1" as any, "1" as any, "999999999999999" as any,
  );
  return new OrderBook(instrument);
}
const sell = (id: string, price: bigint, qty: bigint) => new Order(id, Side.SELL, price, qty);
const buy = (id: string, price: bigint, qty: bigint) => new Order(id, Side.BUY, price, qty);

describe("OB-D3-03: candle + 24h ticker survive snapshot round-trip", () => {
  test("volume24h, tradeCount24h, lastPrice and the in-progress candle persist", () => {
    const src = makeBook();
    // Two crossing trades to populate buckets + the in-progress candle.
    helperAdd(src, sell("s1", 50n, 100n));
    helperAdd(src, buy("b1", 50n, 60n)); // trade @50 qty 60
    helperAdd(src, buy("b2", 50n, 40n)); // trade @50 qty 40

    const before = src.getStats24h();
    expect(before.volume24h).toBe(100n); // sanity: state is actually populated
    expect(before.tradeCount24h).toBeGreaterThan(0);

    const snap = src.exportSnapshot("TEST.A");
    // The snapshot must carry the market-data fields (the fix).
    expect(snap.volumeBuckets, "snapshot must include volumeBuckets").toBeDefined();
    expect(snap.currentCandle, "snapshot must include the in-progress candle").not.toBeNull();

    // Restore into a fresh book.
    const restored = makeBook();
    restored.importSnapshot(snap);

    const after = restored.getStats24h();
    expect(after.volume24h, "24h volume must survive restart").toBe(before.volume24h);
    expect(after.tradeCount24h).toBe(before.tradeCount24h);
    expect(after.lastPrice).toBe(before.lastPrice);

    // The in-progress candle must round-trip exactly (re-export and compare).
    const reSnap = restored.exportSnapshot("TEST.A");
    expect(reSnap.currentCandle).toEqual(snap.currentCandle);
    expect(reSnap.volumeBuckets).toEqual(snap.volumeBuckets);
    expect(reSnap.tradeCountBuckets).toEqual(snap.tradeCountBuckets);
    expect(reSnap.lastUpdateHour).toBe(snap.lastUpdateHour);
  });

  test("backward-compat: a snapshot lacking the market-data fields still imports (empty buckets)", () => {
    const src = makeBook();
    helperAdd(src, sell("s1", 50n, 100n));
    helperAdd(src, buy("b1", 50n, 100n));

    // Simulate an OLD snapshot written before OB-D3-03 by stripping the fields.
    const snap = src.exportSnapshot("TEST.A");
    delete (snap as Record<string, unknown>).volumeBuckets;
    delete (snap as Record<string, unknown>).tradeCountBuckets;
    delete (snap as Record<string, unknown>).lastUpdateHour;
    delete (snap as Record<string, unknown>).currentCandle;

    const restored = makeBook();
    expect(() => restored.importSnapshot(snap)).not.toThrow();
    // Pre-field behavior preserved: 24h stats reset to empty rather than crashing.
    expect(restored.getStats24h().volume24h).toBe(0n);
  });

  test("currentCandle === null (no trades) round-trips as null", () => {
    const src = makeBook();
    // Resting orders but NO crossing trade → currentCandle stays null.
    helperAdd(src, buy("b1", 49n, 100n));
    helperAdd(src, sell("s1", 51n, 100n));

    const snap = src.exportSnapshot("TEST.A");
    expect(snap.currentCandle).toBeNull();

    const restored = makeBook();
    restored.importSnapshot(snap);
    const reSnap = restored.exportSnapshot("TEST.A");
    expect(reSnap.currentCandle).toBeNull();
    expect(restored.getStats24h().volume24h).toBe(0n);
  });

  test("lastUpdateHour restored: a post-import hour advance evicts only elapsed buckets, not the restored volume", () => {
    const HOUR = 3_600_000;
    const H = 1000; // absolute hour (1000h since epoch) — a >24h-from-zero value
    const src = makeBook();
    // Trade at hour H → volume V1 lands in bucket H%24, lastUpdateHour = H.
    helperAdd(src, sell("s1", 50n, 100n), H * HOUR);
    helperAdd(src, buy("b1", 50n, 70n), H * HOUR); // trade @50 qty 70  (V1 = 70)
    expect(src.getStats24h().volume24h).toBe(70n);

    const snap = src.exportSnapshot("TEST.A");
    expect(snap.lastUpdateHour).toBe(H);

    const restored = makeBook();
    restored.importSnapshot(snap);
    helperSyncAfterImport(restored); // sync the test IdGenerator past imported SIDs

    // A new trade only 2 hours later. advanceBuckets must evict just the 2
    // elapsed hours (H+1, H+2) and KEEP the restored bucket H (within the 24h
    // window). If lastUpdateHour had reset to 0, the jump 0 -> H+2 (>24h) would
    // clear ALL buckets and V1 would be lost — so this asserts the restore.
    helperAdd(restored, sell("s2", 50n, 100n), (H + 2) * HOUR);
    helperAdd(restored, buy("b2", 50n, 30n), (H + 2) * HOUR); // V2 = 30

    expect(restored.getStats24h().volume24h).toBe(100n); // V1 (70, survived) + V2 (30)
  });
});
