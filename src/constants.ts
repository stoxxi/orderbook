// packages/orderbook/src/constants.ts

/** Number of decimal digits the system-wide value ceiling is built from. */
export const SCALE = 18n;

/**
 * System-wide ceiling for any scaled integer value (price, quantity, cost):
 * `10^18 - 1` = 999,999,999,999,999,999. 18 digits supports balances up to
 * ~10B units at precision 8 (10^10 × 10^8 = 10^18) and fits within a
 * PostgreSQL `bigint` (max ~9.2 × 10^18).
 */
export const MAX_SYSTEM_VAL = 10n ** SCALE - 1n;

/**
 * Maximum number of integer digits accepted when parsing display values —
 * guards against BigInt limb-explosion on adversarial input.
 */
export const MAX_INTEGER_DIGITS = 18;

/** Maximum valid scaled price ({@link MAX_SYSTEM_VAL}). */
export const MAX_PRICE_VALUE = MAX_SYSTEM_VAL;

/** Maximum valid scaled quantity ({@link MAX_SYSTEM_VAL}). */
export const MAX_QUANTITY_VALUE = MAX_SYSTEM_VAL;

/**
 * Snapshot/WAL schema version. `importSnapshot` and `deserializeOrder` gate on
 * an EXACT match (not `>=`), so this is a hard compatibility boundary.
 *
 * @remarks
 * BUMP THIS whenever a change alters the MEANING of an existing serialized
 * field or the interpretation of a resting order on restore. Purely ADDITIVE
 * fields that restore to a safe default (e.g. `ioc`, `cumulative*`,
 * `reserved*` were added read-optional, default 0/false) do NOT require a
 * bump. When in doubt, bump — a version gate nobody advances silently
 * downgrades a semantics change into a mis-restored book (the guard exists
 * precisely to fail loud instead).
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Internal fixed-point scale for AMM risk parameters (gamma, sigma²):
 * 1,000,000 gives 6 decimal places of precision in risk constants.
 * See `amm/math.ts`.
 */
export const AMM_MATH_SCALE = 1_000_000n;
