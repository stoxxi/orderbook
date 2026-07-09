// packages/orderbook/src/tradePool.ts

import { ILogger, noOpLogger } from "./logging";
import { Order } from "./order";
import { Trade } from "./trade";
import { Price, Quantity, TradeId } from "./types";

/**
 * Default maximum {@link TradePool} capacity. A cap prevents unbounded memory
 * growth on misuse; size it above the highest expected trades-per-second so
 * steady-state matching never allocates.
 */
export const MAX_POOL_SIZE = 10_000;

/**
 * Object pool for {@link Trade} instances, used by the matching loop to avoid
 * per-trade allocation on the hot path.
 *
 * @remarks
 * Pooling is an *optimization*, never a correctness dependency: when the pool
 * is empty, {@link TradePool.get} constructs a fresh `Trade`; when it is full,
 * {@link TradePool.release} simply drops the object for the GC to collect
 * (with a rate-limited warning). Released objects are sanitized to obviously
 * invalid values so a use-after-release bug surfaces as garbage data instead
 * of a stale-but-plausible trade.
 */
export class TradePool {
  private readonly pool: Trade[] = [];
  private hitCount = 0;
  private missCount = 0;
  private readonly capacity: number;
  private readonly logger: ILogger;

  // Exponential backoff when pool is full
  private poolFullCount = 0;

  constructor(capacity: number = MAX_POOL_SIZE, logger: ILogger = noOpLogger) {
    this.capacity = capacity;
    this.logger = logger.withContext({
      component: "TradePool",
    });
  }

  /**
   * Returns a {@link Trade} initialized with the given fill data — reusing a
   * pooled instance when one is available, constructing a new one otherwise.
   *
   * @param makingOrder The resting (maker) order.
   * @param takingOrder The incoming (taker) order.
   * @param qty The matched quantity (scaled integer).
   * @param price The match price — the maker's price (scaled integer).
   * @param id The unique trade id.
   */
  public get(
    makingOrder: Order<unknown>,
    takingOrder: Order<unknown>,
    qty: Quantity,
    price: Price,
    id: TradeId,
  ): Trade {
    if (this.pool.length > 0) {
      this.hitCount++;
      const trade = this.pool.pop()!;

      // Re-initialize the trade object's properties directly.
      trade.init(makingOrder, takingOrder, qty, price, id);
      return trade;
    }

    this.missCount++;
    return new Trade(makingOrder, takingOrder, qty, price, id);
  }

  /**
   * Returns a {@link Trade} to the pool for reuse. The object is sanitized
   * (zeroed ids/amounts) before pooling; if the pool is at capacity the
   * object is dropped to the GC — a safety valve, not an error.
   *
   * The caller must not touch `trade` after releasing it.
   */
  public release(trade: Trade): void {
    // Only add the object back to the pool if the pool is not over its size limit.
    // This prevents the pool from growing indefinitely and acts as a safety valve.
    if (this.pool.length < this.capacity) {
      // Sanitize the object before returning to the pool
      // This is not for memory leak prevention in JS, but for data integrity.
      // If a bug caused a pooled object to be used without re-initialization,
      // it's better for it to contain obviously invalid data than stale,
      // valid-looking data from a previous trade.
      trade.makingOrderId = "";
      trade.takingOrderId = "";
      trade.matchQuantity = 0n;
      trade.matchPrice = 0n;
      trade.tradeId = 0;

      this.pool.push(trade);
      this.poolFullCount = 0; // Reset counter on successful release
    } else {
      // Pool is full - apply adaptive backpressure
      this.poolFullCount++;

      // Log warning every 1000 occurrences to avoid log spam
      if (this.poolFullCount % 1000 === 0) {
        const stats = this.getPoolStats();
        this.logger.warn("TradePool at capacity - dropping object to GC", {
          capacity: this.capacity,
          poolFullCount: this.poolFullCount,
          poolSize: stats.size,
          hitRate: stats.hitRate.toFixed(3),
          recommendation: "Consider increasing MAX_POOL_SIZE or reducing trade rate",
        });
      }
    }
    // The pool is full, the object is simply not added back. It will be
    // garbage collected, which is the desired behavior in this edge case.
  }

  /**
   * Provides statistics for monitoring the performance and health of the object pool.
   * @returns An object containing the current size, capacity, and effectiveness of the pool.
   */
  public getPoolStats(): {
    size: number;
    capacity: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    const total = this.hitCount + this.missCount;
    return {
      size: this.pool.length,
      capacity: this.capacity,
      hits: this.hitCount,
      misses: this.missCount,
      // Avoid division by zero if no gets have occurred yet.
      hitRate: total === 0 ? 0 : this.hitCount / total,
    };
  }
}

/**
 * Process-wide shared {@link TradePool} singleton (capacity
 * {@link MAX_POOL_SIZE}, silent logger). Hosts that want pool-health logging
 * or a custom capacity can construct their own `TradePool` instead.
 */
export const tradePool = new TradePool(MAX_POOL_SIZE, noOpLogger);
