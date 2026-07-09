// packages/orderbook/__tests__/_helpers.ts
//
// Test helper for direct OrderBook unit tests.
//
// Production code never calls `book.add(order)` with a null SID — the engine
// layer (ShardedExchange) pre-assigns via IdGenerator before the order reaches
// the book. Unit tests that exercise OrderBook in isolation don't have an
// engine around, so they use this helper to emulate the same contract:
//
//   1. A per-book IdGenerator assigns the SID.
//   2. The SID is set on the order BEFORE book.add() is invoked.
//
// This keeps OrderBook pure for ID concerns (no fallback counter) while giving
// unit tests the same ergonomics they had before.

import type { MatchingResult, Order, OrderBook, OrderSid } from "../src/orderBook";
import { IdGenerator } from "../src/idGenerator";

/** IdGenerator bound to a specific OrderBook instance. */
const generators = new WeakMap<OrderBook<any, any>, IdGenerator>();

function getGen(book: OrderBook<any, any>): IdGenerator {
  let g = generators.get(book);
  if (!g) {
    g = new IdGenerator();
    generators.set(book, g);
  }
  return g;
}

/**
 * Assigns a SID from the per-book IdGenerator and adds the order to the book.
 *
 * Mirrors the production pre-assignment contract: SID is set before book.add
 * is invoked. If the order already has a valid SID (e.g. a replay scenario
 * simulation), the caller's SID is preserved and the generator observes it
 * to maintain monotonicity.
 */
export function helperAdd<TOrder extends Order<any>>(
  book: OrderBook<any, TOrder>,
  order: TOrder,
  logicalTimestamp?: number,
): MatchingResult {
  const gen = getGen(book);
  if (order.serverOrderId === null) {
    order.serverOrderId = gen.next();
  } else {
    gen.observe(order.serverOrderId as OrderSid);
  }
  return logicalTimestamp !== undefined ? book.add(order, logicalTimestamp) : book.add(order);
}

/**
 * Pre-assigns a SID to an order without inserting it into a book. Useful for
 * tests that construct orders to pass into lower-level APIs.
 */
export function helperAssignSid<TOrder extends Order<any>>(
  book: OrderBook<any, TOrder>,
  order: TOrder,
): TOrder {
  const gen = getGen(book);
  if (order.serverOrderId === null) {
    order.serverOrderId = gen.next();
  } else {
    gen.observe(order.serverOrderId as OrderSid);
  }
  return order;
}

/**
 * Returns the current next-to-issue SID for the book's test IdGenerator.
 * Useful for tests that assert on SID values.
 */
export function helperCurrentSid(book: OrderBook<any, any>): OrderSid {
  return getGen(book).current();
}

/**
 * Syncs the helper's IdGenerator for `book` past every SID currently known to
 * the book. Call this after `book.importSnapshot(data)` in tests — otherwise
 * the helper's generator still starts from 1 and collides with imported SIDs.
 *
 * Production code does this via ShardedExchange.recoverFromSnapshots, which
 * calls `idGenerator.advanceTo(BigInt(data.nextOrderSid))` on the engine-owned
 * generator. Tests don't have that wrapper, so the helper provides a
 * book-scoped equivalent here.
 */
export function helperSyncAfterImport(book: OrderBook<any, any>): void {
  const gen = getGen(book);
  // Scan every known order's SID and observe the max.
  // We use the public getter surface; `getOrder` is the only per-SID lookup,
  // but there's also (internal) orderMap. Walk both sides of the book via
  // getDepth? Simpler: use a loop over a reasonable range.
  //
  // Better: OrderBook exposes order retrieval by SID, but not an iterator
  // over all orders. For tests, we rely on the book having a snapshot export.
  const snap = book.exportSnapshot("__sync__");
  for (const o of snap.orders) {
    const sid = BigInt(o.serverOrderId);
    gen.observe(sid as OrderSid);
  }
}
