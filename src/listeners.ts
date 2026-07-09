// packages/orderbook/src/listeners.ts

import { Bbo, Depth } from "./depth";
import { OrderSnapshot } from "./order";
import { OrderRejectReason } from "./reasons";
import { TradeSnapshot } from "./trade";
import { Candle, Price, Quantity } from "./types";

// Old forward declaration to avoid circular dependency
// interface OrderBook<T extends Order<unknown>> {}

// Use a type-only import to reference OrderBook without creating runtime circular deps.
// This import is erased from the emitted JS and avoids the forward-declaration hack.
import type { OrderBook } from "./orderBook";

/**
 * Interface for a listener that receives notifications about order lifecycle events.
 *
 * Listeners should treat the `OrderSnapshot` parameter as a read-only, immutable view
 * of the order's state at the moment the event occurred. If a listener needs to
 * change order state it MUST call engine APIs (e.g. cancel/replace) rather than
 * mutating the snapshot.
 *
 * @template TUserData Type of the optional `userData` payload attached to the order.
 *
 * @example
 * ```ts
 * class MyOrderListener implements OrderListener<{ clientId: string }> {
 *   onAccept(orderSnap) {
 *     // orderSnap is an OrderSnapshot<{ clientId: string }>
 *     console.log(`Order ${orderSnap.orderId} accepted for client ${orderSnap.userData?.clientId}`);
 *   }
 *
 *   onFill(orderSnap, trade) {
 *     console.log(`Order ${orderSnap.orderId} filled: ${trade.matchQuantity} @ ${trade.matchPrice}`);
 *   }
 *
 *   // implement other methods as required...
 * }
 * ```
 */
export interface OrderListener<TUserData = unknown> {
  /**
   * Called when an order is successfully accepted into the order book.
   * The order will have a serverOrderId at this point.
   *
   * @param order - Immutable snapshot of the accepted order
   */
  onAccept(order: OrderSnapshot<TUserData>): void;

  /**
   * Called when a new order is rejected during submission.
   *
   * @param order - Immutable snapshot of the rejected order
   * @param code A structured reason code for programmatic handling.
   * @param text A human-readable, descriptive error message for logging.
   */
  onReject(order: OrderSnapshot<TUserData>, code: OrderRejectReason, text: string): void;

  /**
   * Called when an order receives a fill (partial or complete).
   * If the order is completely filled, it will be removed from the book.
   *
   * @param order - Immutable snapshot of the order after the fill
   * @param trade - Immutable trade snapshot with fill details
   */
  onFill(order: OrderSnapshot<TUserData>, trade: TradeSnapshot): void;

  /**
   * Called when an order is successfully cancelled.
   * The order is removed from the book after this callback.
   *
   * @param order - Immutable snapshot of the cancelled order
   */
  onCancel(order: OrderSnapshot<TUserData>): void;

  /**
   * Called when a cancel request is rejected.
   * This can happen if the order doesn't exist or is already filled.
   *
   * @param order - Immutable snapshot of the order that couldn't be cancelled,
   *                or `null` if the order was not found.
   * @param code A structured reason code for programmatic handling.
   * @param text A human-readable, descriptive error message for logging.
   */
  onCancelReject(
    order: OrderSnapshot<TUserData> | null,
    code: OrderRejectReason,
    text: string,
  ): void;

  /**
   * Called when an order is successfully replaced (modified).
   * The passed snapshot will have its price and quantity updated.
   *
   * @param order - Immutable snapshot of the replaced order (with updated values)
   * @param oldQuantity - The previous order quantity
   * @param oldPrice - The previous order price*
   * @param newQuantity - The new order quantity
   * @param newPrice - The new order price
   */
  onReplace(
    order: OrderSnapshot<TUserData>,
    oldQuantity: Quantity,
    oldPrice: Price,
    newQuantity: Quantity,
    newPrice: Price,
  ): void;

  /**
   * Called when a replace request is rejected.
   * This can happen if the order doesn't exist or if the new values are invalid.
   *
   * @param order - Immutable snapshot of the order that couldn't be replaced,
   *                or `null` if the order was not found.
   * @param code  - A structured reason code for programmatic handling.
   * @param text  - A human-readable, descriptive error message for logging.
   */
  onReplaceReject(
    order: OrderSnapshot<TUserData> | null,
    code: OrderRejectReason,
    text: string,
  ): void;
}

/**
 * Listener that receives every consummated trade.
 *
 * @template TUserData Type of the `userData` payload on book orders.
 *
 * @example
 * ```ts
 * class TradeReporter implements TradeListener<{ clientId: string }> {
 *   onTrade(book, trade) {
 *     // `book` is a typed OrderBook<Order<{ clientId: string }>>
 *     console.log(`TRADE: ${trade.matchQuantity} @ ${trade.matchPrice}`);
 *   }
 * }
 * ```
 */
export interface TradeListener<TUserData = unknown> {
  /**
   * Called whenever a trade occurs in the order book.
   * This is called after both orders have been updated but before BBO/depth updates.
   *
   * Note: the `orderBook` parameter is typed but imported as a type-only symbol
   * so implementations should not rely on runtime evaluation of this symbol.
   *
   * @param orderBook - The order book where the trade occurred
   * @param trade     - Immutable trade snapshot
   */
  onTrade(orderBook: OrderBook<TUserData>, trade: TradeSnapshot): void;

  /**
   * Called when a 1-minute candle closes (a new trade arrives in a later minute).
   * Optional — only implement if candle persistence/streaming is needed.
   */
  onCandleClosed?(orderBook: OrderBook<TUserData>, candle: Candle): void;
}

/**
 * Listener for Best Bid and Offer (BBO) changes.
 *
 * @template TUserData Type of the `userData` payload on book orders.
 *
 * @example
 * ```ts
 * class BboTracker implements BboListener {
 *   onBboChange(book, bbo) {
 *     console.log(`New BBO: ${bbo.bidPrice}×${bbo.bidQuantity} | ${bbo.askPrice}×${bbo.askQuantity}`);
 *   }
 * }
 * ```
 */
export interface BboListener<TUserData = unknown> {
  /**
   * Called whenever the best bid or offer changes.
   * This includes price changes, quantity changes, or when the top level is removed.
   *
   * **CRITICAL CONTRACT:** The `bbo` parameter is a reference to a pre-allocated
   * double-buffer owned by the engine. You MUST either:
   * 1. Process the BBO synchronously within this callback, OR
   * 2. Extract the primitive values (bidPrice, etc.) you need immediately.
   *
   * Do NOT hold a reference to the `bbo` object for deferred processing (e.g.,
   * setTimeout, queueMicrotask). The engine will overwrite this buffer on the
   * next tick, causing your deferred read to see corrupted future state.
   *
   * @param orderBook - The order book where the BBO changed
   * @param bbo       - Best bid & offer (double-buffered, read synchronously only)
   */
  onBboChange(orderBook: OrderBook<TUserData>, bbo: Bbo): void;
}

/**
 * Listener for full order book depth updates.
 *
 * Depth snapshots can be large and frequent. Consumers should avoid copying
 * the entire snapshot indiscriminately; prefer sampling or throttling if needed.
 *
 * @template TUserData Type of the `userData` payload on book orders.
 *
 * @example
 * ```ts
 * class DepthAnalyzer implements DepthListener {
 *   onDepthChange(book, depth) {
 *     console.log(`Depth: ${depth.bids.length} bids, ${depth.asks.length} asks`);
 *   }
 * }
 * ```
 */
export interface DepthListener<TUserData = unknown> {
  /**
   * Called whenever the order book depth changes.
   * This can be very frequent, so consider throttling or using snapshots in production.
   *
   * @param orderBook - The order book where the depth changed
   * @param depth     - The full depth snapshot
   */
  onDepthChange(orderBook: OrderBook<TUserData>, depth: Depth): void;
}
