// packages/orderbook/src/errors.ts

import { OrderRejectReason } from "./reasons";

/**
 * Custom error class for OrderBook specific issues.
 * Allows for programmatic error handling based on error codes.
 */
export class OrderBookError extends Error {
  public readonly code: OrderRejectReason;

  constructor(code: OrderRejectReason, message: string) {
    super(message);
    this.name = "OrderBookError";
    this.code = code;
  }

  toString(): string {
    return `${this.name} (${this.code}): ${this.message}`;
  }
}

/**
 * Thrown when a system-level invariant is violated (e.g., WAL corruption).
 * This error should NOT be caught by the matching loop; it should trigger
 * a process restart to prevent data corruption.
 *
 * Every invariant tripwire should include structured context so that a
 * 3am-oncall operator sees the root-cause location in the error itself,
 * not in the surrounding log archaeology. Typical fields:
 *   { symbol, clientOrderId, sequenceNumber, type, path, observedSid }
 */
export class FatalEngineError extends Error {
  public readonly context?: Readonly<Record<string, unknown>>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "FatalEngineError";
    this.context = context ? Object.freeze({ ...context }) : undefined;
    // Ensure stack trace is captured correctly in Bun/Node
    Error.captureStackTrace?.(this, FatalEngineError);
  }

  toString(): string {
    const ctxStr = this.context
      ? ` ${JSON.stringify(this.context, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`
      : "";
    return `${this.name}: ${this.message}${ctxStr}`;
  }
}
