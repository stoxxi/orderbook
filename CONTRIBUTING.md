# Contributing to @stoxxi/orderbook

Thanks for your interest — bug reports, questions, and ideas are genuinely
welcome. Please **[open an issue](https://github.com/stoxxi/orderbook/issues)**.

## How this repository works

This repo is a **published mirror**. The engine is developed in a private
upstream project and mirrored here on each release. As a result:

- **Pull requests can't be merged here** — the next release mirror would
  overwrite them. Please don't spend effort on a PR to this repo.
- **Open an issue instead.** Describe the bug or the change you'd like. Accepted
  fixes and improvements are ported upstream and ship in the next version, with
  credit to the reporter.

For a security concern, please open an issue marked as such (or use the contact
on [stoxxi.com](https://stoxxi.com)) rather than posting exploit detail publicly.

## Invariants any change must preserve

If you propose a change, it has to hold the guarantees that make this engine
usable in production:

- **No behaviour change without a failing test first** — reproduce, then fix.
- **Determinism is sacred** — nothing time-, random-, or iteration-order-
  dependent may enter the matching path. Time is an injected logical timestamp.
- **All arithmetic stays `bigint`** — no floats anywhere.
- **Untrusted input stays bounded** — snapshot/wire fields are validated before
  use (see the "Snapshot/wire trust" note in the README).

## Local development

```bash
bun install
bun test          # full suite
bunx tsc -b       # type-check + build
bun run bench     # benchmarks
```
