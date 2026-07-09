// packages/orderbook/__bench__/orderBook.bench.ts
// Run with: bun run packages/orderbook/__bench__/orderBook.bench.ts
//
// Measures `OrderBook.add` throughput for non-crossing limit orders (passive
// adds). Iterations use ascending prices on the same side so no matching
// occurs — this isolates the cost of insertion + price-level bookkeeping.
//
// Updated 2026-05-13 (Bun 1.3.14 baseline rot): orders now receive a valid
// `serverOrderId` from `IdGenerator.next()` before `OrderBook.add()`, per
// the trust-boundary contract introduced in PR2.1 (Step 2 atomicity).
// SID minting cost (a BigInt postincrement) is included in the timed loop
// because that is how the production hot path looks.

import { IdGenerator } from "../src/idGenerator";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

function bench(name: string, fn: () => void, iterations = 5) {
  const times: number[] = [];

  // Warmup
  fn();

  for (let i = 0; i < iterations; i++) {
    const start = Bun.nanoseconds();
    fn();
    const end = Bun.nanoseconds();
    times.push((end - start) / 1_000_000); // ms
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`${name}:`);
  console.log(`  avg: ${avg.toFixed(2)}ms | min: ${min.toFixed(2)}ms | max: ${max.toFixed(2)}ms`);
}

console.log("OrderBook Performance Benchmarks\n" + "=".repeat(40));

bench("Add 1M Limits", () => {
  // Fresh book and id-generator per iteration so the warmup run does not
  // leave residual depth that biases later iterations.
  const book = OrderBook.create("TEST");
  const idGen = new IdGenerator();
  for (let i = 0; i < 1_000_000; i++) {
    const o = new Order(`id${i}`, Side.BUY, 10000n + BigInt(i), 10n);
    o.serverOrderId = idGen.next();
    book.add(o);
  }
});
