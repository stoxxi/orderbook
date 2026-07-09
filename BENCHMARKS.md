# Benchmarks

Honest performance envelope for `@stoxxi/orderbook` on the Bun/TypeScript runtime.
Numbers are throughput and tail latency, not marketing copy — judge them against a
realistic target for this platform (sustained ≥0.5M ops/sec, p50 in the ~1µs range,
no GC-driven p999 cliffs), **not** against C++ sub-microsecond matching engines.

## Commands

```bash
bun run bench                              # runs every __bench__/*.bench.ts
bun run __bench__/match.bench.ts           # match throughput (1 full fill / iter)
bun run __bench__/orderBook.bench.ts       # add throughput (1M resting limits)
bun run __bench__/cancel-o1.bench.ts       # cancel latency percentiles + O(1) check
bun run __bench__/flush-sweep.bench.ts     # O(N) sweep+flush regression check
```

## Methodology

- Each bench warms the JIT on the real code path before timing.
- Latency benches (`cancel-o1`) record a per-op array (tens of thousands of samples)
  and report **p50 / p99 / p999**, not a single cold sample. Cancel numbers include
  the `dispatchNotifications()` BBO/depth diff that runs on every op — that is the
  honest per-op cost, still O(1) in queue size.
- `flush-sweep` reports **ns-per-maker** across N ∈ {100, 1k, 10k, 50k}. Per-maker
  is inflated at small N by fixed setup/JIT overhead and falls as that amortizes,
  settling toward the marginal cost by large N. The regression signal is the
  opposite: per-maker **rising** at large N would flag a super-linear (O(N²)) flush.

## Representative run

> ⚠️ **Environment matters — these are not canonical.** The run below is a **dev
> laptop** (MacBook Pro, Apple M1 Pro, 16 GB; Bun 1.3.14, shared CPU, turbo enabled),
> captured 2026-07-07. A dedicated
> CPU with turbo disabled is the reference environment for regression tracking; treat
> these as an order-of-magnitude picture, and re-measure on the reference box before
> gating on absolute thresholds.

| Bench | Result |
|---|---|
| `match` (1M full fills) | 1319 ms → **~758k matches/sec** (~1.32 µs/match) |
| `orderBook` (add 1M limits) | avg 1458 ms (min 1349 / max 1641) → **~686k adds/sec** (~1.46 µs/add) |
| `cancel` front | p50 **0.17 µs** · p99 1.58 µs · p999 13.4 µs (n=20k) |
| `cancel` back | p50 **0.13 µs** · p99 1.21 µs · p999 6.5 µs (n=20k) |
| `cancel` position independence | back-p50 / front-p50 ≈ **0.6–0.8×** (within a small constant factor is expected for O(1); the real evidence is both p50s being sub-µs and not growing with queue depth) |
| `flush-sweep` per-maker | 100→647 ns, 1k→515 ns, 10k→465 ns, 50k→**461 ns** (falls then settles as fixed overhead amortizes; a *rising* per-maker at large N would flag O(N²)) |

Match latency (~1.3 µs) is the honest steady-state figure — the engine is **not**
sub-microsecond on this platform for matching (cancel-only ops are). See the
`instrument.ts` note, corrected in the P2-4 doc reconciliation.
