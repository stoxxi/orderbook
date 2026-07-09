// packages/orderbook/__bench__/match.bench.ts
// Run with: bun run packages/orderbook/__bench__/match.bench.ts
//
// Measures match throughput: aggressive BUY orders fully fill against a
// seeded queue of SELL makers at the same price. Each iteration in the
// timed loop produces exactly one full fill (taker fully consumes one
// maker), so the reported rate is per-match, not per-fill-event.
//
// Updated 2026-05-13 (Bun 1.3.14 baseline rot): all orders now receive a
// valid `serverOrderId` from `IdGenerator.next()` before `OrderBook.add()`,
// per the trust-boundary contract introduced in PR2.1 (Step 2 atomicity).
//
// Methodology change also in this commit: maker seed count is now equal to
// ITERATIONS (was 100k regardless of ITERATIONS). The old code only matched
// for the first 100k takers; the remaining 900k passive-queued as BUYs at
// the same price, so the reported number was a hybrid of match + add, not
// the pure-match rate the file name claims. Equal seed restores the
// invariant that every timed iteration produces exactly one full fill.

import { IdGenerator } from "../src/idGenerator";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

const SYMBOL = "BENCH";
const ITERATIONS = 1_000_000;
const PRICE = 10000n;
const QTY = 10n;

// Warmup JIT
console.log("Warming up JIT...");
{
  const warmIdGen = new IdGenerator();
  for (let i = 0; i < 1000; i++) {
    const warmup = OrderBook.create("WARM");
    const maker = new Order("m", Side.SELL, PRICE, QTY);
    maker.serverOrderId = warmIdGen.next();
    const taker = new Order("t", Side.BUY, PRICE, QTY);
    taker.serverOrderId = warmIdGen.next();
    warmup.add(maker);
    warmup.add(taker);
  }
}

const book = OrderBook.create(SYMBOL);
const idGen = new IdGenerator();

// Seed book with passive liquidity (outside the timed region). Each maker
// is consumed by exactly one taker in the timed loop below — that's why we
// need at least ITERATIONS makers.
console.log(`Seeding ${ITERATIONS.toLocaleString()} passive orders...`);
for (let i = 0; i < ITERATIONS; i++) {
  const o = new Order(`maker-${i}`, Side.SELL, PRICE, QTY);
  o.serverOrderId = idGen.next();
  book.add(o);
}

console.log("Starting match benchmark...");
const start = Bun.nanoseconds();

// Aggressive flow (timed). Each taker fully fills one maker.
for (let i = 0; i < ITERATIONS; i++) {
  const taker = new Order(`taker-${i}`, Side.BUY, PRICE, QTY);
  taker.serverOrderId = idGen.next();
  book.add(taker);
}

const elapsed = (Bun.nanoseconds() - start) / 1_000_000; // ms
const ops = ITERATIONS / (elapsed / 1000);

console.log(`Elapsed: ${elapsed.toFixed(2)} ms`);
console.log(`Throughput: ${Math.round(ops).toLocaleString()} matches/sec`);
