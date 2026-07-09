// packages/orderbook/src/depth.ts

import { Price, Quantity } from "./types";

/**
 * Represents a single price level in the order book depth.
 *
 * @example
 * ```typescript
 * const level: DepthLevel = {
 *   price: toPrice(100.50),
 *   quantity: 1500,
 *   orderCount: 3
 * };
 * ```
 */
export interface DepthLevel {
  price: Price;
  quantity: Quantity;
  orderCount: number;
}

/**
 * Represents the best bid and offer (BBO) in the market.
 * This is the top of book information showing the best prices to buy and sell.
 *
 * @example
 * ```typescript
 * const bbo: Bbo = {
 *   bidPrice: toPrice(100.45),
 *   bidQuantity: 500,
 *   askPrice: toPrice(100.55),
 *   askQuantity: 300
 * };
 * console.log(`Spread: ${fromInternalPrice(bbo.askPrice - bbo.bidPrice)}`);
 * ```
 */
export interface Bbo {
  bidPrice: Price;
  bidQuantity: Quantity;
  askPrice: Price;
  askQuantity: Quantity;
}

/**
 * Represents a snapshot of the order book's depth at a moment in time.
 * This provides a view of all price levels and their quantities.
 *
 * @example
 * ```typescript
 * const depth = new Depth();
 * depth.addBidLevel({ price: toPrice(100.45), quantity: 500, orderCount: 2 });
 * depth.addAskLevel({ price: toPrice(100.55), quantity: 300, orderCount: 1 });
 *
 * console.log(`${depth.bids.length} bid levels, ${depth.asks.length} ask levels`);
 * ```
 */
export class Depth {
  public bids: DepthLevel[] = [];
  public asks: DepthLevel[] = [];
  public lastChange: number = 0;

  /**
   * Clears all bid and ask levels from the depth.
   */
  public clear(): void {
    this.bids = [];
    this.asks = [];
  }

  /**
   * Creates a clone of the depth snapshot.
   *
   * Performs a defensive copy of each DepthLevel object.
   * This ensures that external listeners cannot accidentally mutate
   * the internal state of the OrderBook through shared references.
   */
  public shallowClone(): Depth {
    const d = new Depth();
    // Defensive copy: Create new object literals for every level
    d.bids = this.bids.map((l) => ({ ...l }));
    d.asks = this.asks.map((l) => ({ ...l }));

    d.lastChange = this.lastChange;

    return d;
  }

  /**
   * Returns a readonly view without cloning. Caller MUST NOT mutate.
   */
  public unsafeView(): Readonly<Depth> {
    return this;
  }

  /**
   * Adds a bid level to the depth.
   *
   * @param level - The bid level to add
   */
  public addBidLevel(level: DepthLevel): void {
    this.bids.push(level);
  }

  /**
   * Adds an ask level to the depth.
   *
   * @param level - The ask level to add
   */
  public addAskLevel(level: DepthLevel): void {
    this.asks.push(level);
  }
}
