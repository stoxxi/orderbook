// packages/orderbook/src/limit.ts

import { FatalEngineError } from "./errors";
import { Order } from "./order";
import { Price, Quantity } from "./types";

/**
 * Represents a single price level in the order book.
 *
 * Uses an intrusive doubly-linked list for O(1) operations:
 * - addOrder: O(1) append to tail
 * - removeOrder: O(1) pointer manipulation
 * - popFront: O(1) head removal (delegates to removeOrder)
 * - peekFront: O(1) head access
 *
 * DESIGN PRINCIPLES:
 * - Intrusive: Order objects ARE the nodes (zero allocation)
 * - Typed: No `as any` casts (V8 JIT optimization)
 * - Safe: Double-enqueue + double-removal guards prevent list corruption
 *
 * CRITICAL INVARIANTS:
 * 1. An Order can only belong to ONE Limit at a time
 * 2. totalQuantity === Sum(orders.openQuantity) at all times
 * 3. Pointer integrity: node._next._prev === node (if _next exists)
 *
 * @template T A class that extends Order.
 */
export class Limit<T extends Order<unknown>> {
  /** The price point this Limit represents. */
  public readonly price: Price;

  /** Sum of openQuantity of all orders at this level. */
  public totalQuantity: Quantity = 0n;

  // ═══════════════════════════════════════════════════════════════════════════
  // INTRUSIVE LINKED-LIST STATE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Head of the queue (highest time priority). */
  private head: T | null = null;

  /** Tail of the queue (lowest time priority). */
  private tail: T | null = null;

  /**
   * Number of orders at this level.
   *
   * Rationale: Count drift doesn't cause solvency errors or list corruption.
   * It only affects metrics/monitoring. The linked list remains structurally
   * correct even if this counter drifts. totalQuantity is the critical
   * aggregate that affects matching correctness.
   */
  private _orderCount: number = 0;

  constructor(price: Price) {
    if (price == null || price < 0n) {
      throw new Error(
        `Invariant violation: Limit price must be a non-negative bigint. Received: ${price}`,
      );
    }
    this.price = price;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ACCESSORS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Number of orders at this price level. */
  public get orderCount(): number {
    return this._orderCount;
  }

  /** True if no orders at this level. */
  public isEmpty(): boolean {
    return this.head === null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUEUE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Adds an order to the back of the queue (FIFO).
   * Complexity: O(1)
   *
   * @param order The order to add.
   * @throws Error if order has no serverOrderId
   * @throws Error if order already belongs to a Limit (P0 DOUBLE-ENQUEUE GUARD)
   */
  public addOrder(order: T): void {
    // ═══════════════════════════════════════════════════════════════════════
    // DOUBLE-ENQUEUE GUARD
    // An order can only belong to ONE Limit at a time. Enqueuing an order
    // that is already linked will corrupt the original list's pointers.
    // This is a FATAL invariant violation - we throw immediately.
    // ═══════════════════════════════════════════════════════════════════════
    if (order._limit !== null) {
      // Cast to any to access .price for the error message
      const existingLimit = order._limit as any;

      throw new Error(
        `INVARIANT VIOLATION: Order ${order.serverOrderId} is already linked to Limit@${existingLimit.price}. ` +
          `Cannot add to Limit@${this.price}. This would corrupt the linked list.`,
      );
    }

    // Validate order has serverOrderId
    if (order.serverOrderId === null) {
      throw new Error("Cannot add order without serverOrderId to Limit");
    }

    // Set back-pointer for O(1) removal (typed access - no `as any`)
    order._limit = this as unknown as typeof order._limit;
    order._prev = this.tail as typeof order._prev;
    order._next = null;

    // Link into list
    if (this.tail !== null) {
      this.tail._next = order as typeof this.tail._next;
    } else {
      // Empty list - order becomes head
      this.head = order;
    }
    this.tail = order;

    // Update aggregates
    this._orderCount++;
    this.totalQuantity += order.openQuantity;
  }

  /**
   * Removes a specific order from anywhere in the queue.
   * Complexity: O(1)
   *
   * SAFETY GUARDS:
   * - Double-Removal Guard: Checks `_limit === this` AND `serverOrderId !== null`
   * - Quantity Underflow Guard: Asserts `totalQuantity >= order.openQuantity`
   *
   * @param order The order to remove.
   * @returns True if removed, false if not found or already removed.
   * @throws Error if removal would cause totalQuantity underflow (invariant violation)
   */
  public removeOrder(order: T): boolean {
    // ═══════════════════════════════════════════════════════════════════════
    // DOUBLE-REMOVAL GUARD
    // Prevents list corruption if removeOrder is called twice on same order
    // ═══════════════════════════════════════════════════════════════════════

    // Guard 1: Order must have a valid serverOrderId (not already purged)
    if (order.serverOrderId === null) {
      return false;
    }

    // Guard 2: Order must belong to THIS limit (not a different price level)
    if (order._limit !== (this as unknown as typeof order._limit)) {
      return false;
    }

    // Guard 3: Defensive: Cycle Detection - CRITICAL CORRUPTION (Fatal)
    // If this is true, the list is circular. We must crash the process
    // to prevent an infinite loop in the matching engine.
    if (order._next === (order as any) || order._prev === (order as any)) {
      throw new FatalEngineError(
        `DURABILITY VIOLATION: Cyclic pointer detected in Order ${order.orderId}`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // QUANTITY UNDERFLOW GUARD
    // If openQuantity was mutated without calling updateQuantity(), this
    // will catch the drift before it corrupts totalQuantity.
    // ═══════════════════════════════════════════════════════════════════════
    if (this.totalQuantity < order.openQuantity) {
      throw new Error(
        `INVARIANT VIOLATION: Limit@${this.price} totalQuantity (${this.totalQuantity}) ` +
          `would underflow on removal of order ${order.serverOrderId} with openQuantity ${order.openQuantity}. ` +
          `This indicates openQuantity was mutated without calling updateQuantity().`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POINTER MANIPULATION (O(1) unlink)
    // ═══════════════════════════════════════════════════════════════════════

    const prev = order._prev as T | null;
    const next = order._next as T | null;

    // Update previous node's next pointer (or head if removing head)
    if (prev !== null) {
      prev._next = next as typeof prev._next;
    } else {
      // Order was head - advance head
      this.head = next;
    }

    // Update next node's prev pointer (or tail if removing tail)
    if (next !== null) {
      next._prev = prev as typeof next._prev;
    } else {
      // Order was tail - retreat tail
      this.tail = prev;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CLEANUP (prevent stale references and enable double-removal detection)
    // ═══════════════════════════════════════════════════════════════════════

    order._prev = null;
    order._next = null;
    order._limit = null;

    // Update aggregates
    this._orderCount--;
    this.totalQuantity -= order.openQuantity;

    return true;
  }

  /**
   * Updates total quantity by a delta.
   *
   * CRITICAL: This method MUST be called whenever an order's openQuantity
   * is mutated (e.g., during partial fills). Failure to do so will cause
   * totalQuantity drift and trigger the underflow guard on removal.
   *
   * @param delta Change in quantity (positive or negative).
   */
  public updateQuantity(delta: Quantity): void {
    this.totalQuantity += delta;
  }

  /**
   * Idiomatic Iterator
   * Allows: for (const order of limit) { ... }
   *
   * Cycle guard: walks at most `2 × _orderCount` nodes before throwing.
   * The intrusive linked list is acyclic by construction (Limit.addOrder
   * + removeOrder maintain head/tail/_next/_prev correctly), so a cycle
   * indicates a pointer-integrity bug elsewhere — sandbox.ts's
   * fingerprint walks this iterator on the hot path, and an undetected
   * cycle would hang CI/prod. Throw is preferable to infinite loop.
   */
  public *[Symbol.iterator](): Iterator<T> {
    let current = this.head;
    let steps = 0;
    const maxSteps = this._orderCount * 2;
    while (current !== null) {
      if (++steps > maxSteps) {
        throw new Error(
          `Limit.[Symbol.iterator]: walked > ${maxSteps} nodes (orderCount=${this._orderCount}, price=${this.price}); linked-list cycle detected`,
        );
      }
      yield current;
      current = current._next as T | null;
    }
  }

  /**
   * Peeks at the front order without removing.
   * Complexity: O(1)
   *
   * @returns The front order or undefined if empty.
   */
  public peekFront(): T | undefined {
    return this.head ?? undefined;
  }

  /**
   * Removes and returns the front order.
   * Complexity: O(1)
   *
   * DRY PATTERN: Delegates to removeOrder() to ensure single source of truth
   * for pointer manipulation, aggregate updates, and index maintenance.
   *
   * @returns The removed order or undefined if empty.
   */
  public popFront(): T | undefined {
    if (this.head === null) {
      return undefined;
    }

    const order = this.head;

    // Delegate to removeOrder - single source of truth for unlinking
    this.removeOrder(order);

    return order;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBUG UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Iterates over all orders in queue order (head to tail).
   * Complexity: O(N)
   *
   * Use for debugging, logging, and invariant verification in tests.
   * NOT for production hot paths.
   *
   * SAFETY: Iteration is safe even if callback throws - no list mutation occurs.
   * However, modifying the list during iteration (add/remove) is undefined behavior.
   *
   * @param callback Function to call for each order with (order, index).
   */
  public forEach(callback: (order: T, index: number) => void): void {
    let current = this.head;
    let index = 0;
    while (current !== null) {
      callback(current, index);
      current = current._next as T | null;
      index++;
    }
  }

  /**
   * Returns an array of all orders (for debugging).
   * Complexity: O(N)
   *
   * Useful for test assertions and logging. Allocates a new array.
   *
   * @returns Array of orders in queue order.
   */
  public toArray(): T[] {
    const result: T[] = [];
    this.forEach((order) => result.push(order));
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLONE (Step 2 engine-atomicity refactor — see
  // docs/architecture/06-step2-engine-atomicity-refactor.md §5.6)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns a structural clone of this Limit with a fresh intrusive
   * linked list of cloned Orders.
   *
   * Algorithm: walk the live list head→tail; for each live order,
   * produce a clone via `Order.clone()` (pointers null) and append to
   * the clone Limit via `addOrder()`. `addOrder()` rebuilds the linked
   * list correctly AND increments `_orderCount` and `totalQuantity`,
   * so the clone Limit's invariants
   *   - `node._next._prev === node` for every node
   *   - `totalQuantity === Σ(orders.openQuantity)`
   *   - `_orderCount === number of orders`
   * hold by construction without any explicit pointer rewiring at the
   * `Limit.clone` layer.
   *
   * Pointers do NOT cross Limit boundaries (each Limit has its own
   * head/tail; orders at one price level do not link to orders at
   * another). So per-Limit cloning is self-contained — no shared
   * identity-map pass needed within a single Limit.
   *
   * The shared `ordersIdentityMap` is populated as we clone, so
   * higher layers (`OrderBook.clone()`) can rebuild their own
   * order-keyed maps (e.g., `orderMap: Map<OrderSid, Order>`) using
   * the clone Order references rather than the live ones.
   *
   * @param ordersIdentityMap Mutable map populated with `live → clone`
   *   pairs as orders are cloned. Caller may pre-create this map and
   *   reuse it across multiple `Limit.clone()` calls (e.g., for both
   *   bids and asks of the same OrderBook).
   * @returns A new Limit at the same price, with cloned orders in
   *   identical FIFO order.
   */
  public clone(ordersIdentityMap: Map<T, T>): Limit<T> {
    const clonedLimit = new Limit<T>(this.price);
    let cur = this.head;
    while (cur !== null) {
      const clonedOrder = cur.clone() as T;
      ordersIdentityMap.set(cur, clonedOrder);
      clonedLimit.addOrder(clonedOrder);
      cur = cur._next as T | null;
    }
    return clonedLimit;
  }
}
