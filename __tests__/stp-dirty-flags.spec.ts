// packages/orderbook/__tests__/stp-dirty-flags.spec.ts
//
// OB-D3-01 regression: the Self-Trade-Prevention (STP) cancel path removes
// the resting maker from the book but historically forgot to mark the depth
// and BBO dirty — every other removal path does. Because the published
// BBO/depth are only recomputed by dispatchNotifications() WHEN a dirty flag
// is set, a *pure-STP* order (one that cancels a maker but produces no actual
// trade and doesn't rest) left the cached top-of-book pointing at a level the
// book no longer holds, and nothing re-dirtied it afterwards → a stale /
// crossed BBO that never self-heals in a thin market.
//
// The test uses a MARKET taker (price 0n → IOC) so the taker never rests:
// the ONLY book mutation is the STP maker-removal. If that path doesn't set
// the dirty flags, getBbo() returns the stale maker price.

import { describe, expect, test } from "bun:test";
import { helperAdd } from "./_helpers";
import { createInstrument, Order, OrderBook, Side, UserSTPPolicy } from "../src";

type UD = { userId: string };

function makeStpBook() {
  const instrument = createInstrument(
    "TEST.A" as any, 0, 0, "1" as any, "1" as any, "999999999999999" as any,
  );
  return new OrderBook<UD>(instrument, undefined, undefined, new UserSTPPolicy<UD>());
}

describe("OB-D3-01 — STP self-cancel marks BBO/depth dirty", () => {
  test("pure-STP market taker that cancels the only ask clears the cached ask in getBbo()", () => {
    const book = makeStpBook();
    const userA: UD = { userId: "user-A" };

    // user-A rests a SELL (ask) at 60.
    helperAdd(book, new Order<UD>("maker-ask", Side.SELL, 60n, 5n, userA));

    // Populate the BBO cache — ask is currently 60.
    const before = book.getBbo();
    expect(before.askPrice).toBe(60n);
    expect(before.askQuantity).toBe(5n);

    // user-A sends a MARKET BUY (price 0n → IOC). It crosses the resting ask,
    // STP fires (same user) → the maker ask is cancelled with NO trade, and
    // the IOC market remainder is cancelled WITHOUT resting. The maker-removal
    // is the only book mutation, so only the STP path can mark BBO dirty.
    helperAdd(book, new Order<UD>("taker-mkt", Side.BUY, 0n, 5n, userA));

    // The book now holds no asks. Without OB-D3-01's dirty-marking the cached
    // BBO would still report ask=60 (stale); with it, the ask is cleared.
    const after = book.getBbo();
    expect(after.askPrice).toBe(0n);
    expect(after.askQuantity).toBe(0n);
    // No bid was created (market taker didn't rest).
    expect(after.bidPrice).toBe(0n);
  });

  test("depth snapshot reflects the STP-cancelled level", () => {
    const book = makeStpBook();
    const userA: UD = { userId: "user-A" };

    // getDepth() only rebuilds the snapshot when a depth listener is attached
    // (rebuildDepth early-returns otherwise), so register one to exercise the
    // real depth path the dirty flag drives.
    book.setDepthListener({ onDepthChange: () => {} });

    helperAdd(book, new Order<UD>("maker-ask-2", Side.SELL, 70n, 3n, userA));
    // Prime the cache — the ask level is present now.
    expect(book.getDepth().asks.find((l) => l.price === 70n)).toBeDefined();

    helperAdd(book, new Order<UD>("taker-mkt-2", Side.BUY, 0n, 3n, userA));

    const depth = book.getDepth();
    // The ask level the STP-cancel removed must not appear in the snapshot.
    // Without OB-D3-01's depthIsDirty mark, the cached snapshot still shows it.
    expect(depth.asks.find((l) => l.price === 70n)).toBeUndefined();
  });
});
