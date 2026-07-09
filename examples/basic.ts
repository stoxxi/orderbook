// examples/basic.ts — minimal end-to-end CLOB session.
//
// Run from packages/orderbook:  bun run examples/basic.ts
//
// In your own app, import from the published package instead:
//   import { IdGenerator, Order, OrderBook, Side } from "@stoxxi/orderbook";
import {
  IdGenerator,
  Order,
  OrderBook,
  OrderRejectReason,
  Side,
  type OrderListener,
} from "../src/index";

// ── Setup ────────────────────────────────────────────────────────────────────
// A book priced to 2 decimals, whole-unit quantities, 0.01 tick.
const book = OrderBook.create("DEMO", {
  pricePrecision: 2,
  quantityPrecision: 0,
  tickSize: "0.01",
});

// The HOST owns identity: assign a monotonic server order id (sid) to every
// order BEFORE the book sees it. Journal the command (sid included) first and
// a replay reproduces the identical book.
const idGen = new IdGenerator();

// Logical time — any monotonic ms value owned by your sequencer. The book
// itself never reads the clock (determinism contract).
let ts = 1_000_000;

// ── Listeners ────────────────────────────────────────────────────────────────
const fmtP = (p: bigint) => book.fromInternalPrice(p);
const fmtQ = (q: bigint) => book.fromInternalQuantity(q);

const orderListener: OrderListener = {
  onAccept: (o) => console.log(`  [accept]  ${o.orderId} sid=${o.serverOrderId}`),
  onReject: (o, code, text) =>
    console.log(`  [reject]  ${o.orderId} ${OrderRejectReason[code]}: ${text}`),
  onFill: (o, t) =>
    console.log(`  [fill]    ${o.orderId} ${fmtQ(t.matchQuantity)} @ ${fmtP(t.matchPrice)} (open=${fmtQ(o.openQuantity)})`),
  onCancel: (o) => console.log(`  [cancel]  ${o.orderId}`),
  onCancelReject: (o, code, text) =>
    console.log(`  [cxl-rej] ${o?.orderId ?? "?"} ${OrderRejectReason[code]}: ${text}`),
  onReplace: (o, oldQ, oldP, newQ, newP) =>
    console.log(`  [replace] ${o.orderId} ${fmtQ(oldQ)}@${fmtP(oldP)} → ${fmtQ(newQ)}@${fmtP(newP)}`),
  onReplaceReject: (o, code, text) =>
    console.log(`  [rpl-rej] ${o?.orderId ?? "?"} ${OrderRejectReason[code]}: ${text}`),
};
book.setOrderListener(orderListener);

book.setTradeListener({
  onTrade: (b, t) =>
    console.log(`  [TRADE]   ${fmtQ(t.matchQuantity)} @ ${fmtP(t.matchPrice)} (maker=${t.makingOrderId} taker=${t.takingOrderId})`),
});

book.setBboListener({
  onBboChange: (_b, bbo) => {
    // NOTE: Bbo is a reused double-buffer — read synchronously, never retain it.
    const bid = bbo.bidPrice > 0n ? `${fmtP(bbo.bidPrice)}×${fmtQ(bbo.bidQuantity)}` : "—";
    const ask = bbo.askPrice > 0n ? `${fmtP(bbo.askPrice)}×${fmtQ(bbo.askQuantity)}` : "—";
    console.log(`  [BBO]     ${bid} | ${ask}`);
  },
});

// Helper: create → assign sid → add.
function submit(orderId: string, side: Side, price: string, qty: bigint) {
  const order = new Order(orderId, side, book.toInternalPrice(price), qty);
  order.serverOrderId = idGen.next();
  const result = book.add(order, ts++);
  console.log(`  [result]  ${orderId}: ${result.status}, remaining=${fmtQ(result.remainingQuantity)}`);
  return order;
}

// ── Session ──────────────────────────────────────────────────────────────────
console.log("1. Alice quotes both sides:");
const aliceAsk = submit("alice-ask", Side.SELL, "10.05", 5n);
submit("alice-bid", Side.BUY, "9.95", 5n);

console.log("\n2. Bob lifts the ask for 3 (partial fill — 2 keep resting):");
submit("bob-buy", Side.BUY, "10.05", 3n);

console.log("\n3. Alice reprices her residual ask down to 10.00 (loses time priority):");
// newQuantity is the new TOTAL (FIX CumQty floor): 3 already filled + 2 open = 5.
book.replace(aliceAsk.serverOrderId!, 5n, book.toInternalPrice("10.00"), ts++);

console.log("\n4. Carol sweeps it with a bigger buy — 2 fill, 4 rest as the new best bid:");
const carolBuy = submit("carol-buy", Side.BUY, "10.00", 6n);

console.log("\n5. Carol cancels her resting remainder (O(1)):");
book.cancel(carolBuy.serverOrderId!, ts++);

console.log("\nFinal state:");
const bbo = book.getBbo();
console.log(`  best bid: ${bbo.bidPrice > 0n ? fmtP(bbo.bidPrice) : "—"}`);
console.log(`  best ask: ${bbo.askPrice > 0n ? fmtP(bbo.askPrice) : "—"}`);
const stats = book.getStats24h();
console.log(`  24h volume=${fmtQ(stats.volume24h)} trades=${stats.tradeCount24h} last=${stats.lastPrice ? fmtP(stats.lastPrice) : "—"}`);
