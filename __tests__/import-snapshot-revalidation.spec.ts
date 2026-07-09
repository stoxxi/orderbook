import { describe, expect, test } from "bun:test";
import { helperAdd, helperSyncAfterImport } from "./_helpers";
import { Order } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { Side } from "../src/types";
import { FatalEngineError } from "../src/errors";
import { MAX_QUANTITY_VALUE } from "../src/constants";

// P2-1 (REVIEW-20260707-FABLE5.md): importSnapshot staged+validated negative/SID/duplicate
// only — it did NOT re-check tick alignment, price bounds, or the quantity ceiling that
// `add()` enforces on the live-insert path. A snapshot whose orders violate instrument
// rules restored silently, producing a book holding orders `add()` would reject. Restore
// should fail loudly (FatalEngineError → all-or-nothing) instead of accept-then-mismatch.
//
// The book uses tickSize 0.10 (internal tick = 10n) so integer prices can be misaligned;
// with the default 0.01 tick every integer price is aligned and the gap is untestable.
function bookWithCoarseTick() {
  return OrderBook.create<{ userId: string }>("T", { tickSize: "0.10" });
}

function validSnapshot() {
  const src = bookWithCoarseTick();
  const o = new Order<{ userId: string }>("a", Side.BUY, 100n, 10n, { userId: "u1" }); // 1.00, aligned
  helperAdd(src, o);
  return src.exportSnapshot("T");
}

describe("importSnapshot re-validates restored orders against instrument rules", () => {
  test("a valid snapshot still restores cleanly (control)", () => {
    const snap = validSnapshot();
    const dst = bookWithCoarseTick();
    expect(() => dst.importSnapshot(snap)).not.toThrow();
    helperSyncAfterImport(dst);
  });

  test("tick-misaligned restored price is rejected (was accepted before P2-1)", () => {
    const snap = validSnapshot();
    snap.orders[0].price = "105"; // 1.05 — not a multiple of the 0.10 tick
    const dst = bookWithCoarseTick();
    expect(() => dst.importSnapshot(snap)).toThrow(FatalEngineError);
  });

  test("out-of-bounds restored price is rejected (was accepted before P2-1)", () => {
    const snap = validSnapshot();
    // Above maxPrice (system ceiling snapped to tick) but still tick-aligned,
    // so this isolates the bounds check from the tick check.
    snap.orders[0].price = "1000000000000000000"; // 10^18, > MAX_PRICE_VALUE (10^18 - 1)
    const dst = bookWithCoarseTick();
    expect(() => dst.importSnapshot(snap)).toThrow(FatalEngineError);
  });

  test("over-max restored quantity is rejected (was accepted before P2-1)", () => {
    const snap = validSnapshot();
    const huge = (MAX_QUANTITY_VALUE + 1000n).toString();
    snap.orders[0].orderQuantity = huge;
    snap.orders[0].openQuantity = huge;
    const dst = bookWithCoarseTick();
    expect(() => dst.importSnapshot(snap)).toThrow(FatalEngineError);
  });

  test("a rejected restore leaves the destination book untouched (all-or-nothing)", () => {
    // Seed dst with a real order, then attempt a bad restore — the prior book must survive.
    const dst = bookWithCoarseTick();
    const seed = new Order<{ userId: string }>("seed", Side.BUY, 100n, 5n, { userId: "u0" });
    helperAdd(dst, seed);
    const before = JSON.stringify(dst.exportSnapshot("T"));

    const snap = validSnapshot();
    snap.orders[0].price = "105";
    expect(() => dst.importSnapshot(snap)).toThrow(FatalEngineError);

    expect(JSON.stringify(dst.exportSnapshot("T"))).toBe(before);
  });
});
