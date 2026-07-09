// examples/snapshot-restore.ts — snapshot → restore → continue, proving
// replay equivalence: after restoring a snapshot, the SAME subsequent
// commands produce the SAME trades and the SAME final book state.
//
// Run from packages/orderbook:  bun run examples/snapshot-restore.ts
//
// In your own app, import from the published package instead:
//   import { IdGenerator, Order, OrderBook, Side } from "@stoxxi/orderbook";
import { IdGenerator, Order, OrderBook, Side, type TradeSnapshot } from "../src/index";

const INSTRUMENT = {
  pricePrecision: 2,
  quantityPrecision: 0,
  tickSize: "0.01",
} as const;

function newBook() {
  return OrderBook.create("DEMO", { ...INSTRUMENT });
}

// Deterministic command script we can apply to any book. The host owns
// identity (sids) and logical time — both are part of the recorded commands,
// which is exactly what makes replay reproduce the identical book.
type Cmd =
  | { kind: "add"; orderId: string; side: Side; price: string; qty: bigint; sid: bigint; ts: number }
  | { kind: "cancel"; sid: bigint; ts: number };

function apply(book: OrderBook, cmd: Cmd): void {
  if (cmd.kind === "add") {
    const order = new Order(cmd.orderId, cmd.side, book.toInternalPrice(cmd.price), cmd.qty);
    order.serverOrderId = cmd.sid;
    book.add(order, cmd.ts);
  } else {
    book.cancel(cmd.sid, cmd.ts);
  }
}

function collectTrades(book: OrderBook): TradeSnapshot[] {
  const trades: TradeSnapshot[] = [];
  book.setTradeListener({ onTrade: (_b, t) => trades.push(t) });
  return trades;
}

// ── Phase 1: live session, then snapshot ────────────────────────────────────
const live = newBook();
const idGen = new IdGenerator();
let ts = 1_000_000;

const phase1: Cmd[] = [
  { kind: "add", orderId: "a1", side: Side.SELL, price: "10.10", qty: 5n, sid: idGen.next(), ts: ts++ },
  { kind: "add", orderId: "a2", side: Side.SELL, price: "10.05", qty: 3n, sid: idGen.next(), ts: ts++ },
  { kind: "add", orderId: "b1", side: Side.BUY, price: "9.95", qty: 4n, sid: idGen.next(), ts: ts++ },
  { kind: "add", orderId: "b2", side: Side.BUY, price: "10.05", qty: 2n, sid: idGen.next(), ts: ts++ }, // trades 2 vs a2
];
for (const cmd of phase1) apply(live, cmd);

// Snapshot the resting state. All bigints are already strings — plain JSON.
const snapshotJson = JSON.stringify(live.exportSnapshot(live.getSymbol()));
console.log(`Snapshot taken: ${live.getDepth().bids.length} bid level(s), ${live.getDepth().asks.length} ask level(s)`);

// ── Phase 2: the same post-snapshot commands, on the live book AND a restored one
const phase2: Cmd[] = [
  { kind: "add", orderId: "c1", side: Side.BUY, price: "10.10", qty: 6n, sid: idGen.next(), ts: ts++ }, // sweeps a2 rem + a1
  { kind: "cancel", sid: phase1[2].sid, ts: ts++ }, // cancel b1
  { kind: "add", orderId: "d1", side: Side.SELL, price: "9.90", qty: 1n, sid: idGen.next(), ts: ts++ }, // rests (bid side is empty)
];

// (a) Continue on the live book.
const liveTrades = collectTrades(live);
for (const cmd of phase2) apply(live, cmd);

// (b) Restore the snapshot into a fresh book and replay the same commands.
const restored = newBook();
restored.importSnapshot(JSON.parse(snapshotJson));
await restored.recover(); // post-restore invariant verification — throws if corrupt
const restoredTrades = collectTrades(restored);
for (const cmd of phase2) apply(restored, cmd);

// ── Verify equivalence ───────────────────────────────────────────────────────
const summarize = (trades: TradeSnapshot[]) =>
  trades.map((t) => `${t.makingOrderId}/${t.takingOrderId}:${t.matchQuantity}@${t.matchPrice}`).join(", ");

const liveSummary = summarize(liveTrades);
const restoredSummary = summarize(restoredTrades);
const liveFinal = JSON.stringify(live.exportSnapshot(live.getSymbol()));
const restoredFinal = JSON.stringify(restored.exportSnapshot(restored.getSymbol()));

console.log(`\nPhase-2 trades (live):     ${liveSummary}`);
console.log(`Phase-2 trades (restored): ${restoredSummary}`);

if (liveSummary !== restoredSummary) {
  throw new Error("REPLAY MISMATCH: restored book produced different trades");
}
if (liveFinal !== restoredFinal) {
  throw new Error("REPLAY MISMATCH: final snapshots differ");
}
console.log("\nPASS: Replay equivalence holds: identical trades AND identical final snapshot.");
