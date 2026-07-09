# Changelog

All notable changes to `@stoxxi/orderbook`. The public version line begins at
**1.1.0**, the package's first npm release.

## 1.1.2

Code-quality cleanup surfaced by static analysis — no matching/lifecycle/
determinism change.

- Removed a dead, misleading constant (`DEFAULT_TICK_SIZE`, which claimed `1`
  while `OrderBook.create` actually defaults the tick size to `"0.01"`).
- Fixed a test that only *looked* like it verified error-class separation: it
  constructed an `OrderBookError` but never threw it, so the `instanceof
  OrderBookError` branch was never exercised. It now checks both classes.
- Removed unused imports/locals across the test suite and enabled
  `noUnusedLocals` / `noUnusedParameters`, so unused code in `src` fails the
  build (`tsc -b`) and unused test imports surface via the test type-check
  config (`tsconfig.spec.json`) and code scanning.
- Documented two intentional serializer duplications in `src/wire.ts`
  (`tradeSnapshotToWire` mirroring `Trade.toWire`, and the wire length-cap
  deliberately throwing `TypeError` — reject the record — rather than the
  snapshot path's halting `FatalEngineError`).

## 1.1.1

Packaging and metadata only — no source-logic or matching-behaviour change.

- **Public source repository:** `repository`, `bugs`, and `homepage` now point
  at the package's own public repo (github.com/stoxxi/orderbook), and the README
  links resolve there instead of a private location. The package is developed
  upstream and mirrored to that repo on each release; issues are welcome there
  (see `CONTRIBUTING.md`).
- **Cleaner static scan:** internal snapshot-field labels were reworded from a
  `word.word` shape to plain words so supply-chain scanners don't misread them
  as URLs. Diagnostic strings only — no behavioural effect. (The package makes
  no network calls of any kind.)
- Declared `@types/bun` as a dev dependency so the repository type-checks and
  tests standalone.

## 1.1.0 — First open-source release

First standalone, publicly published release. Extracted from the Stoxxi
monorepo with no change to matching/lifecycle/determinism behaviour.

- **Security hardening (pre-publish audit):** bounded the untrusted
  snapshot/wire deserialize boundary — every serialized numeric string is now
  length-capped before `BigInt()` (`src/serialization.ts`, guards a
  single-threaded-venue parse DoS); `importSnapshot` now bounds `openQuantity`
  (`≤ MAX_QUANTITY_VALUE` and `≤ orderQuantity`), not only `orderQuantity`, and
  rejects `cumulativeFilledQuantity > orderQuantity` (can't fill more than
  ordered); `wireToTradeSnapshot` now enforces a magnitude ceiling on
  `matchPrice`/`matchQuantity`; the self-trade-prevention debug log emits only
  `userId`, never the full `userData` object; and `@js-sdsl/ordered-map` is
  pinned to an exact version (the price-ordering tree). See the README
  "Snapshot/wire trust" note.
- **Standalone:** vendored the tiny `ILogger`/`noOpLogger` (`src/logging.ts`)
  and `IExchangeMetrics`/`noOpMetrics` (`src/metrics.ts`) contracts — the
  package has zero private workspace dependencies; sole runtime dependency is
  `@js-sdsl/ordered-map`. Both contracts are exported so hosts can inject
  their own implementations. No behaviour change (no-op defaults unchanged).
- **Docs:** outward-facing README (quickstart, numeric model, determinism/
  replay contract, snapshot & recover, FIX mapping, honest performance
  envelope); complete TSDoc across the public API surface.
- **Packaging:** publish-ready `package.json` (MIT © Double Digitize, keywords,
  `sideEffects: false`, `publishConfig.access: public`, `prepublishOnly`
  build+test+Node-ESM-smoke gate), MIT `LICENSE` file, runnable `examples/`.
- **Node.js compatibility:** the build now rewrites relative specifiers in the
  emitted `dist/` to explicit `.js` extensions (`scripts/fix-esm-extensions.mjs`)
  so the published ESM loads under Node (≥ 18) as well as Bun — previously the
  artifact was importable only by Bun. Source stays extensionless (bundlers
  consuming the source, e.g. Turbopack, do not alias `.js`→`.ts`). ESM-only
  (no CommonJS build). Source maps are excluded from the npm tarball (they
  referenced `../src`, which is not shipped).
