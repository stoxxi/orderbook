// packages/orderbook/src/trade.ts

import { Order } from "./order";
import { Cost, OrderId, Price, Quantity, TradeId } from "./types";
import { WireTradeSnapshot } from "./wire";

/**
 * A plain data interface representing the immutable data of a consummated trade.
 * This is the safe object that is passed to external listeners.
 */
export interface TradeSnapshot {
  readonly matchPrice: Price;
  readonly matchQuantity: Quantity;
  readonly makingOrderId: OrderId;
  readonly takingOrderId: OrderId;
  readonly tradeId: TradeId;
}

/**
 * Represents a consummated trade between a making and a taking order.
 * This is an immutable data object created by the OrderBook during a match.
 *
 * NOTE: The properties are NOT marked as `readonly` to allow this class to be
 * used with an object pool (`tradePool.ts`), which requires re-initializing
 * properties for performance. The "immutability" is a convention that applies
 * for the lifecycle of the trade outside of the pool.
 *
 * * @example
 * ```typescript
 * const trade = new Trade(makingOrder, takingOrder, 100, 150.50, 12345);
 * console.log(`Trade ${trade.tradeId}: ${trade.matchQuantity} @ ${trade.matchPrice}`);
 * console.log(`Cost: ${trade.cost()}`);
 * ```
 */
export class Trade {
  // Properties are now mutable to support object pooling.
  public matchPrice!: Price;
  public matchQuantity!: Quantity;
  public makingOrderId!: OrderId;
  public takingOrderId!: OrderId;
  public tradeId!: TradeId;

  /**
   * The constructor is used when creating a new Trade instance, typically when
   * an object pool is empty. It immediately calls the `init` method.
   */
  constructor(
    makingOrder: Order<unknown>,
    takingOrder: Order<unknown>,
    matchQuantity: Quantity,
    matchPrice: Price,
    tradeId: TradeId,
  ) {
    this.init(makingOrder, takingOrder, matchQuantity, matchPrice, tradeId);
  }

  /**
   * An initialization method used by both the constructor and the object pool
   * to set or reset all properties of the trade object. This is the core of
   * making the class pool-friendly.
   *
   * @param makingOrder The order that was resting on the book.
   * @param takingOrder The order that initiated the trade.
   * @param matchQuantity The quantity that was traded.
   * @param matchPrice The price at which the trade occurred (the maker's price).
   * @param tradeId The unique ID for this trade.
   */
  public init(
    makingOrder: Order<unknown>,
    takingOrder: Order<unknown>,
    matchQuantity: Quantity,
    matchPrice: Price,
    tradeId: TradeId,
  ): void {
    this.matchPrice = matchPrice;
    this.matchQuantity = matchQuantity;
    this.makingOrderId = makingOrder.orderId;
    this.takingOrderId = takingOrder.orderId;
    this.tradeId = tradeId;
  }

  /**
   * Calculates the total cost of this trade (quantity × price).
   * The result is a scaled integer, just like price and quantity.
   * @returns The total cost of the trade.
   */
  public cost(): Cost {
    return this.matchQuantity * this.matchPrice;
  }

  /**
   * Creates a safe, immutable snapshot of the trade data.
   * @returns A TradeSnapshot object.
   */
  public snapshot(): TradeSnapshot {
    return {
      matchPrice: this.matchPrice,
      matchQuantity: this.matchQuantity,
      makingOrderId: this.makingOrderId,
      takingOrderId: this.takingOrderId,
      tradeId: this.tradeId,
    };
  }

  /** Create a JSON-safe representation for wire transport */
  public toWire(): WireTradeSnapshot {
    return {
      matchPrice: this.matchPrice.toString(), // because JSON.stringify can't handle bigint
      matchQuantity: this.matchQuantity.toString(),
      makingOrderId: this.makingOrderId,
      takingOrderId: this.takingOrderId,
      tradeId: this.tradeId.toString(),
    };
  }
}
