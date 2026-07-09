// scripts/fix-esm-extensions.mjs
//
// Post-build step: rewrite extensionless relative import/export specifiers in
// the emitted dist/ to explicit ".js" so the published package loads under
// Node ESM (which requires full specifiers). The SOURCE stays extensionless
// because in-monorepo consumers resolve it via tsconfig paths with bundlers
// (Turbopack, Bun) that do not support .js→.ts extension aliasing.
//
// Idempotent: specifiers already ending in .js (or .json) are left alone.
// Applied to .js emit and .d.ts declarations (Node16-mode consumers resolve
// declaration specifiers the same way).
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;

// from "./x" | from '../y' | import("./z") — relative specifiers only.
const SPECIFIER = /(from\s+|import\()(["'])(\.\.?\/[^"']+)\2/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|d\.ts)$/.test(name)) yield p;
  }
}

let rewritten = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(SPECIFIER, (m, lead, q, spec) =>
    /\.(js|json)$/.test(spec) ? m : (rewritten++, `${lead}${q}${spec}.js${q}`),
  );
  if (after !== before) writeFileSync(file, after);
}
console.log(`fix-esm-extensions: ${rewritten} specifier(s) rewritten in dist/`);
