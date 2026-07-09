// packages/orderbook/src/logging.ts
//
// Vendored logging contract. The order book is pure matching logic and never
// performs I/O itself — all diagnostics flow through this interface, injected
// by the host. The default is `noOpLogger` (silent), so the hot path pays
// nothing unless the host opts in.

/**
 * A bag of structured key/value pairs attached to a log entry.
 *
 * @remarks
 * Values are intentionally `unknown` — hosts decide how to serialize them
 * (note that order/trade objects contain `bigint` fields, which
 * `JSON.stringify` rejects without a replacer).
 */
export type LogContext = Record<string, unknown>;

/**
 * Minimal structured-logging contract the order book emits through.
 *
 * Implement this to route the book's diagnostics into your own logging
 * stack, or pass nothing to keep it silent ({@link noOpLogger} is the
 * default everywhere a logger is accepted).
 *
 * @remarks
 * The book only ever *calls* these methods; it never reads logger state.
 * Levels used: `debug` for per-order flow, `info` for lifecycle milestones,
 * `warn` for recoverable anomalies, `error`/`fatal` for consistency
 * violations (a `fatal` from the book means the book threw and should be
 * considered corrupt — see the README's error-handling contract).
 *
 * @example
 * ```ts
 * const consoleLogger: ILogger = {
 *   debug: (m, c) => console.debug(m, c),
 *   info: (m, c) => console.info(m, c),
 *   warn: (m, c) => console.warn(m, c),
 *   error: (m, e, c) => console.error(m, e, c),
 *   fatal: (m, e, c) => console.error("FATAL", m, e, c),
 *   withContext: () => consoleLogger,
 * };
 * const book = new OrderBook(instrument, consoleLogger);
 * ```
 */
export interface ILogger {
  /** Log fine-grained diagnostic detail (per-order accept/cancel/trade flow). */
  debug(message: string, context?: LogContext): void;
  /** Log a lifecycle milestone (book initialized, recovery verified). */
  info(message: string, context?: LogContext): void;
  /** Log a recoverable anomaly worth an operator's attention. */
  warn(message: string, context?: LogContext): void;
  /** Log an error, optionally with the causing `Error` and structured context. */
  error(message: string, error?: Error, context?: LogContext): void;
  /** Log an unrecoverable consistency violation (the book is about to throw). */
  fatal(message: string, error?: Error, context?: LogContext): void;
  /**
   * Return a child logger with `context` permanently bound to every entry.
   * The book calls this once at construction to tag entries with the symbol.
   */
  withContext(context: LogContext): ILogger;
}

class NoOpLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  withContext(): ILogger {
    return this;
  }
}

/**
 * Silent {@link ILogger} — every method is a no-op and `withContext` returns
 * the same singleton. This is the default logger for {@link OrderBook} and
 * {@link TradePool}; the matching hot path stays allocation-free and silent
 * unless the host injects a real logger.
 */
export const noOpLogger: ILogger = new NoOpLogger();
