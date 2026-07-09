// packages/orderbook/src/metrics.ts
//
// Vendored metrics contract. Like logging, metrics are injected and
// no-op by default — the book itself performs no I/O and holds no
// metrics state beyond calling these hooks.

/**
 * A monotonically increasing counter.
 *
 * @remarks
 * Maps directly onto a Prometheus/OpenTelemetry counter; adapt your metrics
 * library by implementing these two methods.
 */
export interface MetricCounter {
  /** Add `value` to the counter, optionally tagged with `labels`. */
  add(value: number, labels?: Record<string, string>): void;
  /** Shorthand for `add(1, labels)`. */
  inc(labels?: Record<string, string>): void;
}

/**
 * Minimal metrics contract the order book reports through.
 *
 * The book increments `tradesExecuted` (labelled with the instrument
 * symbol) once per executed trade. Pass an implementation to the
 * {@link OrderBook} constructor to wire it into your metrics stack, or
 * omit it to use the silent {@link noOpMetrics} default.
 *
 * @remarks
 * Determinism note: {@link OrderBook.clone} accepts a metrics override —
 * pass {@link noOpMetrics} when cloning for speculative/sandbox compute so
 * replayed matching on the clone never double-counts production metrics
 * (by default a clone shares its parent's metrics sink).
 *
 * @example
 * ```ts
 * const metrics: IExchangeMetrics = {
 *   tradesExecuted: {
 *     add: (n, labels) => myCounter.inc(labels, n),
 *     inc: (labels) => myCounter.inc(labels, 1),
 *   },
 * };
 * const book = new OrderBook(instrument, noOpLogger, metrics);
 * ```
 */
export interface IExchangeMetrics {
  /** Incremented by 1 per executed trade, labelled `{ symbol }`. */
  readonly tradesExecuted: MetricCounter;
}

/**
 * Silent {@link IExchangeMetrics} — the default for {@link OrderBook}.
 * Also the value to pass to {@link OrderBook.clone} for sandbox/what-if
 * clones so they never pollute production counters.
 */
export const noOpMetrics: IExchangeMetrics = {
  tradesExecuted: {
    add(): void {},
    inc(): void {},
  },
};
