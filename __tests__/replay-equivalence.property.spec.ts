import { describe, expect, test } from "bun:test";
import { helperAdd, helperSyncAfterImport } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";
import { FatalEngineError } from "../src/errors";

// P2-2 (REVIEW-20260707-FABLE5.md): the flagship `wal-replay-invariant.spec.ts` inlines an
// ad-hoc pointer walk and never drives the production enforcer `recover()` /
// `assertPostReplayInvariants()`, nor does it test replay EQUIVALENCE (restore-mid-stream ==
// uninterrupted). Determinism is actually sound (the review proved it) — this spec locks
// that in as a machine-checked property over the real public API, and drives the enforcer.

// Deterministic LCG — no Math.random, so the property is itself replayable.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
}

function drive(book: OrderBook, n: number, seed: number, sidBase = 0n) {
  const rnd = lcg(seed);
  let sid = sidBase;
  for (let i = 0; i < n; i++) {
    const side = rnd() < 0.5 ? Side.BUY : Side.SELL;
    const price = BigInt(9900 + Math.floor(rnd() * 20) * 10); // tick-aligned (default tick = 1)
    const qty = BigInt(1 + Math.floor(rnd() * 10));
    const o = new Order(`o${i}`, side, price, qty);
    o.serverOrderId = ++sid;
    helperAdd(book, o, i); // logical ts = i (deterministic, injected)
  }
}

describe("replay equivalence (property): restore-mid-stream == uninterrupted", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    test(`seed ${seed}: 200 ops, snapshot at 120, byte-identical export`, () => {
      const a = OrderBook.create("T");
      drive(a, 120, seed);
      const snap = a.exportSnapshot("T");

      // Continue A with a second deterministic sub-stream.
      const contSeed = seed ^ 0xabcdef;
      drive(a, 80, contSeed, 10_000n);

      // Restore into B, continue with the identical sub-stream.
      const b = OrderBook.create("T");
      b.importSnapshot(snap);
      helperSyncAfterImport(b);
      drive(b, 80, contSeed, 10_000n);

      expect(JSON.stringify(a.exportSnapshot("T"))).toBe(JSON.stringify(b.exportSnapshot("T")));
      expect(a.getStats24h()).toEqual(b.getStats24h());
    });
  }
});

describe("quantity conservation (property)", () => {
  test("Σ resting openQty == Σ added when nothing crosses", () => {
    const book = OrderBook.create("T");
    // All makers one side, no cross → nothing matches; resting total must equal sum added.
    let added = 0n;
    for (let i = 0; i < 50; i++) {
      const o = new Order(`b${i}`, Side.BUY, 9000n, BigInt(i + 1));
      o.serverOrderId = BigInt(i + 1);
      helperAdd(book, o);
      added += BigInt(i + 1);
    }
    const bookAny = book as unknown as { bids: { forward(): Iterable<{ totalQuantity: bigint }> } };
    let sum = 0n;
    for (const lim of bookAny.bids.forward()) sum += lim.totalQuantity;
    expect(sum).toBe(added);
  });
});

describe("recover() drives the production invariant enforcer", () => {
  test("a detached (ghost) order makes recover() throw FatalEngineError", async () => {
    const book = OrderBook.create("T");
    const o = new Order("g", Side.BUY, 10000n, 10n);
    o.serverOrderId = 1n;
    helperAdd(book, o);

    // Corrupt the book the way a bad replay would: the order is still in orderMap
    // (live) but detached from its Limit → Invariant 6 (bi-directional reachability)
    // must catch it. This exercises assertPostReplayInvariants via the public recover().
    (o as unknown as { _limit: unknown })._limit = null;

    await expect(book.recover()).rejects.toThrow(FatalEngineError);
  });

  test("recover() on a coherent book resolves cleanly (control)", async () => {
    const book = OrderBook.create("T");
    const o = new Order("ok", Side.BUY, 10000n, 10n);
    o.serverOrderId = 1n;
    helperAdd(book, o);
    await expect(book.recover()).resolves.toBeUndefined();
  });
});
