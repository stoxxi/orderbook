// packages/orderbook/src/orderMultimap.ts
//
// Sorted price-keyed map of Limit objects backing every price level in
// an OrderBook. Hot path: every order add / cancel / replace / fill
// traverses this structure.
//
// Implementation note (2026-05-14 migration):
//   Previously backed by `jstreemap.TreeMultiMap` (last published 2020,
//   marked discontinued by Snyk). Now backed by `@js-sdsl/ordered-map`'s
//   `OrderedMap` — a TypeScript port of C++ STL `std::map`. The "multi-
//   map" aspect was never used by this class — multi-key semantics are
//   handled inside the per-price `Limit` (FIFO doubly-linked queue);
//   the tree only ever stores `Price → single Limit`. A plain ordered
//   map is the correct primitive. See issue #120 for rationale.

import { OrderedMap } from "@js-sdsl/ordered-map";
import { Limit } from "./limit";
import { Order } from "./order";
import { Price, Quantity } from "./types";

/**
 * Module-level comparator. Hoisted out of the OrderMultiMap constructor so
 * every instance shares the same function reference — `toEqual()`-style
 * deep-equality between two OrderMultiMaps (used by `OrderBook.clone`
 * regression tests) requires reference equality on the underlying
 * OrderedMap's `cmp` field, and a fresh closure per instance would
 * spuriously fail. Bigint-safe: avoids `a - b` which can overflow Number
 * if a future price-precision bump pushes values past 2^53.
 */
const priceComparator = (a: Price, b: Price): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * A high-performance, sorted map that stores Limit objects at each price level.
 * This component is designed to be a robust, self-validating data structure.
 *
 * @template T A class that extends Order.
 */
export class OrderMultiMap<T extends Order<unknown>> {
  private readonly tree = new OrderedMap<Price, Limit<T>>([], priceComparator);

  /**
   * Gets the Limit object for a specific price level.
   * This is required by the OrderBook for in-place quantity updates.
   * @throws {Error} If the price is null or undefined.
   */
  public get(price: Price): Limit<T> | undefined {
    if (price == null) {
      throw new Error("Price cannot be null or undefined");
    }
    return this.tree.getElementByKey(price);
  }

  /**
   * Inserts an order into the correct Limit object at the correct price level.
   * @throws {Error} If the order is null or undefined.
   */
  public insert(order: T): void {
    if (!order) {
      throw new Error("Order cannot be null or undefined");
    }

    const price = order.price;
    let limit = this.tree.getElementByKey(price);
    if (!limit) {
      limit = new Limit<T>(price);
      this.tree.setElement(price, limit);
    }
    limit.addOrder(order);
  }

  /**
   * Removes a specific order from its Limit object. This is the ONLY method
   * responsible for cleaning up an empty price level.
   * @throws {Error} If the order is null or undefined, or if data corruption is detected.
   */
  public remove(order: T): boolean {
    if (!order) {
      throw new Error("Order cannot be null or undefined");
    }

    const limit = this.tree.getElementByKey(order.price);
    if (limit) {
      const wasRemoved = limit.removeOrder(order);
      if (limit.isEmpty()) {
        // Defensive check: if the queue is empty, the quantity must be zero.
        if (limit.totalQuantity !== 0n) {
          throw new Error(
            `Data corruption detected: Limit queue is empty but total quantity is ${limit.totalQuantity} at price ${order.price}`,
          );
        }
        this.removePriceLevel(order.price);
      }
      return wasRemoved;
    }
    return false;
  }

  /**
   * Updates the aggregated quantity for an order's price level. This is a hot-path
   * method used for in-place quantity updates that retain time priority.
   *
   * ⚠️ **THREAD SAFETY:** This method is designed for a single-threaded environment.
   * Callers must ensure that all operations on the OrderBook are serialized
   * and not interleaved with other asynchronous operations.
   *
   * @param order The order whose price level is being updated.
   * @param quantityDelta The change in quantity (can be positive or negative).
   * @throws {Error} If the price level doesn't exist or if a data corruption/inconsistent state is detected.
   */
  public updateQuantity(order: T, quantityDelta: Quantity): void {
    // 1. Input validation and no-op optimization
    if (quantityDelta === 0n) {
      return;
    }
    if (!order) {
      throw new Error("Order cannot be null or undefined");
    }

    const limit = this.tree.getElementByKey(order.price);

    // If this method is called, the limit MUST exist. Its absence indicates a
    // critical state inconsistency, as in-place updates are only for orders
    // already resting on the book.
    if (!limit) {
      throw new Error(
        `Invariant violation: attempt to update quantity for a non-existent price level at ${order.price.toString()}`,
      );
    }

    // Store old quantity for richer error messages
    const oldQuantity = limit.totalQuantity;
    limit.updateQuantity(quantityDelta);

    // 2. Comprehensive data integrity checks
    if (limit.totalQuantity < 0n) {
      throw new Error(
        `Data corruption detected: negative total quantity ${limit.totalQuantity} at price ${order.price}. ` +
          `Previous: ${oldQuantity}, Delta: ${quantityDelta}`,
      );
    }

    // 3. Detect inconsistent state (logically impossible if used correctly)
    if (limit.totalQuantity === 0n && !limit.isEmpty()) {
      throw new Error(
        `Inconsistent state: zero total quantity but ${limit.orderCount} orders still present at price ${order.price}`,
      );
    }
  }

  /** Gets the best-priced Limit object (lowest price). */
  public getBest(): Limit<T> | undefined {
    // `front()` returns the smallest-keyed entry as `[K, V] | undefined`.
    // Avoids the `begin()` iterator detour and is the documented O(1) path.
    const entry = this.tree.front();
    return entry?.[1];
  }

  /** Gets the best-priced Limit object for a descending view (highest price). */
  public getBestReverse(): Limit<T> | undefined {
    const entry = this.tree.back();
    return entry?.[1];
  }

  /** Returns the total number of price levels. */
  public size(): number {
    return this.tree.size();
  }

  /** Provides a forward iterator for all Limit objects (ascending price). */
  public *forward(): IterableIterator<Limit<T>> {
    if (this.tree.size() === 0) {
      return; // Empty iterator
    }
    // @js-sdsl/ordered-map's Symbol.iterator yields [K, V] in ascending key
    // order. Identical traversal to the old `begin()..end()` walk but with
    // less iterator boilerplate.
    for (const [, limit] of this.tree) {
      yield limit;
    }
  }

  /** Provides a backward iterator for all Limit objects (descending price). */
  public *backward(): IterableIterator<Limit<T>> {
    if (this.tree.size() === 0) {
      return; // Empty iterator
    }
    // OrderedMap doesn't expose a reverse Symbol.iterator, but `rBegin()` /
    // `rEnd()` give a reverse iterator. `.pointer` returns the `[K, V]` tuple.
    const rEnd = this.tree.rEnd();
    for (const it = this.tree.rBegin(); !it.equals(rEnd); it.next()) {
      yield it.pointer[1];
    }
  }

  public removePriceLevel(price: Price): void {
    // OrderedMap exposes `eraseElementByKey(key)` directly, collapsing the
    // jstreemap-era `find(key) + erase(iterator)` pair into one call.
    this.tree.eraseElementByKey(price);
  }

  /** Removes all price levels and orders. Used during snapshot import. */
  public clear(): void {
    this.tree.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLONE (Step 2 engine-atomicity refactor — see
  // docs/architecture/06-step2-engine-atomicity-refactor.md §5.6)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns a structural clone of this multimap. Iterates price-ascending
   * via `forward()` (the same order the underlying OrderedMap exposes for
   * matching), clones each Limit via `Limit.clone()`, and inserts the clone
   * into a fresh OrderedMap.
   *
   * Price-ascending insertion order doesn't matter for tree correctness
   * (OrderedMap is self-balancing on `setElement`), but FIFO order WITHIN
   * a Limit is preserved by `Limit.clone()` walking head→tail.
   *
   * The shared `ordersIdentityMap` is populated as Limits clone their
   * order lists — caller can use it to rebuild order-keyed structures
   * elsewhere (e.g., `OrderBook.orderMap`).
   *
   * @param ordersIdentityMap Mutable map populated with `live → clone`
   *   order pairs.
   * @returns A new OrderMultiMap with cloned Limits at the same prices.
   */
  public clone(ordersIdentityMap: Map<T, T>): OrderMultiMap<T> {
    const cloned = new OrderMultiMap<T>();
    for (const limit of this.forward()) {
      const clonedLimit = limit.clone(ordersIdentityMap);
      cloned.tree.setElement(clonedLimit.price, clonedLimit);
    }
    return cloned;
  }
}
