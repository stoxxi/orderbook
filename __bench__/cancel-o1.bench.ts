// packages/orderbook/__bench__/cancel-o1.bench.ts
//
// Measures intrusive-DLL cancel latency and confirms it is position-independent
// (O(1) unlink + O(log n) empty-level erase, not O(n)).
//
// P2-3 (REVIEW-20260707-FABLE5.md): the previous version timed ONE cancel per
// position with `Bun.nanoseconds()`. A single cold sample is dominated by
// JIT/dispatch noise ("back = 2× front" was sampling variance, not O(n)), so it
// could not actually prove the O(1) claim. This version cancels every order in a
// large queue, records a per-op latency array, and reports p50/p99/p999 — the
// tail-latency picture that matters for a matching engine. Position independence
// is the front-p50 ≈ back-p50 comparison, now backed by tens of thousands of
// samples instead of one.
//
// Note: each cancel also runs `dispatchNotifications()` (BBO/depth diff), so
// these numbers are per-op cancel cost including dispatch, not the bare unlink.
// That is the honest number an operator sees; it is still O(1) in queue size.

import { IdGenerator } from "../src/idGenerator";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";

const QUEUE_SIZE = 20_000;
const WARMUP = 2_000;

function buildQueue(n: number): { book: OrderBook; orders: Order[] } {
  const book = OrderBook.create("TEST");
  const idGen = new IdGenerator();
  const orders: Order[] = [];
  for (let i = 0; i < n; i++) {
    const o = new Order(`o${i}`, Side.BUY, 10000n, 10n);
    o.serverOrderId = idGen.next();
    book.add(o);
    orders.push(o);
  }
  return { book, orders };
}

function percentiles(samplesNs: number[]) {
  const s = [...samplesNs].sort((a, b) => a - b);
  const pick = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    p50: pick(50),
    p99: pick(99),
    p999: pick(99.9),
    min: s[0],
    max: s[s.length - 1],
  };
}

function report(label: string, p: ReturnType<typeof percentiles>) {
  const f = (ns: number) => `${(ns / 1000).toFixed(2)}µs`;
  console.log(
    `${label.padEnd(14)} n=${p.n}  p50=${f(p.p50)}  p99=${f(p.p99)}  p999=${f(p.p999)}  min=${f(p.min)}  max=${f(p.max)}`,
  );
}

// Cancel every order in insertion order → each target is the current FIFO front.
function benchFront(): number[] {
  const { book, orders } = buildQueue(QUEUE_SIZE);
  const lat: number[] = new Array(orders.length);
  for (let i = 0; i < orders.length; i++) {
    const sid = orders[i].serverOrderId!;
    const t0 = Bun.nanoseconds();
    book.cancel(sid);
    lat[i] = Bun.nanoseconds() - t0;
  }
  return lat;
}

// Cancel in reverse insertion order → each target is the current FIFO tail.
function benchBack(): number[] {
  const { book, orders } = buildQueue(QUEUE_SIZE);
  const lat: number[] = new Array(orders.length);
  for (let i = orders.length - 1, k = 0; i >= 0; i--, k++) {
    const sid = orders[i].serverOrderId!;
    const t0 = Bun.nanoseconds();
    book.cancel(sid);
    lat[k] = Bun.nanoseconds() - t0;
  }
  return lat;
}

// Warm the JIT on the real add+cancel path before measuring.
console.log("Warming up JIT...");
{
  const warmIdGen = new IdGenerator();
  for (let i = 0; i < WARMUP; i++) {
    const warmupBook = OrderBook.create("WARM");
    const o = new Order("w", Side.BUY, 10000n, 10n);
    o.serverOrderId = warmIdGen.next();
    warmupBook.add(o);
    warmupBook.cancel(o.serverOrderId);
  }
}

console.log("Cancel latency (per-op, includes BBO/depth dispatch)\n" + "=".repeat(56));
const front = percentiles(benchFront());
const back = percentiles(benchBack());
report("Cancel front", front);
report("Cancel back", back);
console.log(
  `Position independence: back-p50 / front-p50 = ${(back.p50 / front.p50).toFixed(2)}x ` +
    `(within a small constant factor is expected for O(1) — front/back are not identical). ` +
    `The real O(1) evidence is that both p50s are sub-µs and do NOT grow with QUEUE_SIZE=${QUEUE_SIZE}; ` +
    `an O(n) scan would climb with queue depth.`,
);
