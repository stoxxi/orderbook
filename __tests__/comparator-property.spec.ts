// packages/orderbook/__tests__/comparator-property.spec.ts
//
// Pins the price-ordering semantics of the underlying @js-sdsl/ordered-map tree
// (a caret dependency, ^4.4.2). The engine's entire notion of "best price" is
// only as correct as this comparator + tree. A minor-version regression that
// changed iteration order or best()/back() would silently corrupt matching, so
// this test locks the contract: OrderMultiMap must always yield strictly
// price-sorted levels, with getBest()=lowest and getBestReverse()=highest, and
// it must be bigint-safe past 2^53 (a future price-precision bump).

import { describe, expect, test } from "bun:test";
import { Order } from "../src/order";
import { OrderMultiMap } from "../src/orderMultimap";
import { Side, type Price } from "../src/types";

let sid = 1n;
function makeOrder(price: bigint): Order {
  const o = new Order(`o-${price}`, Side.BUY, price as Price, 1n);
  o.serverOrderId = sid++;
  return o;
}

function insertAll(map: OrderMultiMap<Order>, prices: bigint[]): void {
  for (const p of prices) map.insert(makeOrder(p));
}

describe("OrderMultiMap comparator / tree ordering (dependency contract)", () => {
  test("forward() yields strictly ascending prices regardless of insertion order", () => {
    const map = new OrderMultiMap<Order>();
    insertAll(map, [50n, 10n, 30n, 90n, 20n, 70n, 40n]);
    const seen = [...map.forward()].map((l) => l.price);
    expect(seen).toEqual([10n, 20n, 30n, 40n, 50n, 70n, 90n]);
    // strictly increasing
    for (let i = 1; i < seen.length; i++) expect(seen[i] > seen[i - 1]).toBe(true);
  });

  test("backward() yields strictly descending prices", () => {
    const map = new OrderMultiMap<Order>();
    insertAll(map, [50n, 10n, 30n, 90n, 20n]);
    const seen = [...map.backward()].map((l) => l.price);
    expect(seen).toEqual([90n, 50n, 30n, 20n, 10n]);
  });

  test("getBest()=lowest price, getBestReverse()=highest price", () => {
    const map = new OrderMultiMap<Order>();
    insertAll(map, [500n, 100n, 300n]);
    expect(map.getBest()!.price).toBe(100n);
    expect(map.getBestReverse()!.price).toBe(500n);
  });

  test("ordering is bigint-safe above 2^53 (no Number() coercion in the comparator)", () => {
    const map = new OrderMultiMap<Order>();
    const base = 9_007_199_254_740_993n; // 2^53 + 1
    // These three differ only in the low bits — Number() would collapse them.
    const prices = [base + 2n, base, base + 1n];
    insertAll(map, prices);
    const seen = [...map.forward()].map((l) => l.price);
    expect(seen).toEqual([base, base + 1n, base + 2n]);
    expect(map.size()).toBe(3); // all three kept distinct
  });

  test("removePriceLevel keeps the remaining order intact", () => {
    const map = new OrderMultiMap<Order>();
    insertAll(map, [10n, 20n, 30n]);
    map.removePriceLevel(20n as Price);
    expect([...map.forward()].map((l) => l.price)).toEqual([10n, 30n]);
    expect(map.get(20n as Price)).toBeUndefined();
  });
});
