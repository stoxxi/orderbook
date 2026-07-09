// packages/orderbook/__bench__/flush-sweep.bench.ts
//
// P2-3 / PRODUCTION_READINESS_PLAN.md §4.3: an O(N)-flush regression bench.
//
// A single aggressive taker that sweeps N resting makers in one match generates
// N fills, each buffered as a deferred callback and drained by `flushCallbacks`
// after the match completes (the Phase-1.1 index-drain fix makes that drain
// O(N), not O(N²)). This bench times that whole one-shot sweep across a range of
// N and reports ns-per-maker. At small N the per-maker figure is inflated by
// fixed setup/JIT overhead and FALLS as N grows (that overhead amortizes); by
// large N it settles toward the true marginal cost. The regression signal is the
// opposite shape: per-maker RISING at large N would flag a super-linear (O(N²))
// flush. Flatness at the large-N end is the healthy state, not flatness overall.

import { IdGenerator } from "../src/idGenerator";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

const PRICE = 10000n;
const MAKER_QTY = 10n;
const SIZES = [100, 1_000, 10_000, 50_000];

function sweepOnce(n: number): number {
  const book = OrderBook.create("SWEEP");
  const idGen = new IdGenerator();

  // Seed N resting makers at one price (outside the timed region).
  for (let i = 0; i < n; i++) {
    const m = new Order(`m${i}`, Side.SELL, PRICE, MAKER_QTY);
    m.serverOrderId = idGen.next();
    book.add(m);
  }

  // One taker consumes the entire book in a single match → N fills → O(N) flush.
  const taker = new Order("taker", Side.BUY, PRICE, MAKER_QTY * BigInt(n));
  taker.serverOrderId = idGen.next();

  const t0 = Bun.nanoseconds();
  book.add(taker);
  return Bun.nanoseconds() - t0;
}

// Warm the JIT on the sweep path.
console.log("Warming up JIT...");
for (let i = 0; i < 50; i++) sweepOnce(200);

console.log("O(N) sweep + flush (single taker consumes N makers)\n" + "=".repeat(56));
let prevPerMaker = 0;
for (const n of SIZES) {
  // Median of a few runs to damp GC noise.
  const runs = [sweepOnce(n), sweepOnce(n), sweepOnce(n)].sort((a, b) => a - b);
  const median = runs[1];
  const perMaker = median / n;
  const ratio = prevPerMaker ? ` (${(perMaker / prevPerMaker).toFixed(2)}x prev/maker)` : "";
  console.log(
    `N=${String(n).padStart(6)}  total=${(median / 1_000_000).toFixed(2)}ms  ` +
      `per-maker=${perMaker.toFixed(1)}ns${ratio}`,
  );
  prevPerMaker = perMaker;
}
console.log(
  "Per-maker falls at small N (fixed setup amortizing), then settles; a per-maker that RISES " +
    "at large N is the super-linear (O(N^2)) regression signal.",
);
