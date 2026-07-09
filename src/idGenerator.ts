// packages/orderbook/src/idGenerator.ts

import type { OrderSid } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  IDENTITY INVARIANT ENFORCEMENT — TRUST BOUNDARIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Core invariant:
 *
 *     All externally observable identity must be assigned before state
 *     mutation (persistence OR in-memory book changes).
 *
 * Enforced at four trust boundaries:
 *
 *   in-memory → durable      Pre-WAL assert in ShardedExchange.processDurableCommand
 *                            — "We never persist invalid commands"
 *
 *   durable → in-memory      Replay guard in ShardedExchange.recoverAll
 *                            — "Disk may be corrupt; validate before use"
 *
 *   caller → engine          Compile-time narrow: SimpleExchange.processCommand
 *                            takes AssignedCommand, not AnyCommand
 *                            — "Callers cannot violate the contract"
 *
 *   engine → book state      Collision tripwire in OrderBook.add
 *                            — "Even if every other guard fails, don't corrupt state"
 *
 * Every guard uses the single predicate isValidSid() defined below, so the
 * notion of "a valid SID" lives in one grep-able location.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Single semantic definition of identity validity.
 *
 * A valid SID is a positive BigInt. This rejects:
 *   - undefined / null / missing field
 *   - 0n (counter starts at 1n; 0n is a sentinel for "unassigned")
 *   - negative BigInts
 *   - number, string, boolean (serialization drift from JSON/msgpack round-trips)
 *
 * Used at every trust boundary (see the comment block above). If the notion
 * of validity ever evolves (e.g. upper bound, range checks, format rules),
 * this is the one place to change.
 */
export function isValidSid(x: unknown): x is OrderSid {
  return typeof x === "bigint" && x > 0n;
}

/**
 * Monotonic BigInt counter for server order IDs.
 *
 * OWNERSHIP: One instance per OrderBook, held by the engine layer
 * (ShardedExchange) — NOT by OrderBook itself. This split is a
 * determinism invariant:
 *
 *   Engine → idGen.next() → AddOrderCommand.serverOrderId set
 *          → WAL.append(cmd) → OrderBook receives order with sid
 *
 * If OrderBook generated the SID (as it used to), live-vs-replay
 * timing differences — e.g., AMM quotes mixed with user orders —
 * would assign different SIDs to the same logical order between
 * the live run and a WAL replay, so CANCEL_ORDER / REPLACE_ORDER
 * commands would reference SIDs that no longer match any order.
 * Assigning SIDs BEFORE WAL persistence eliminates that class of
 * bug by making the SID part of the durable input, not a derived
 * runtime value.
 *
 * Gap-tolerance invariant: SIDs may be non-contiguous within a
 * single book if, say, an ADD_ORDER command is rejected after
 * SID assignment but before reaching the book. Consumers must
 * treat SIDs as opaque monotonic tokens, not as dense indices.
 */
export class IdGenerator {
  private nextSid: OrderSid = 1n;

  /** Returns the next SID and advances the counter. */
  public next(): OrderSid {
    return this.nextSid++;
  }

  /**
   * Observes an externally-assigned SID (from WAL replay or snapshot
   * load). If `sid >= nextSid`, advances nextSid past it so that any
   * post-replay `next()` call is guaranteed to be monotonic across
   * the replay boundary.
   */
  public observe(sid: OrderSid): void {
    if (sid >= this.nextSid) {
      this.nextSid = sid + 1n;
    }
  }

  /** The next SID that `next()` would return (for snapshot/debug). */
  public current(): OrderSid {
    return this.nextSid;
  }

  /**
   * Advances to `min` without ever regressing.
   *
   * Used on engine startup to seed the counter above the highest
   * engine_order_id persisted in the DB from prior sessions — WAL
   * replay alone does not cover cross-epoch DB rows. Only advances.
   */
  public advanceTo(min: OrderSid): void {
    if (min > this.nextSid) {
      this.nextSid = min;
    }
  }

  /** Explicit reset — test helper only. */
  public reset(): void {
    this.nextSid = 1n;
  }

  /**
   * Returns a structural clone of this generator at the same cursor.
   *
   * Used by the Step 2 sandbox builder
   * (`docs/architecture/06-step2-engine-atomicity-refactor.md` §5.6) to
   * give the sandbox its own independent counter — `next()` calls during
   * sandbox compute don't advance the live cursor, and a reverted
   * compute (validation throws, WAL append fails) doesn't leak SID gaps
   * into the live generator. After successful commit, the sandbox's
   * cursor is installed via reference swap (§5.5).
   *
   * Field-completeness: `nextSid` is the only state. Trivial clone.
   */
  public clone(): IdGenerator {
    const c = new IdGenerator();
    c.nextSid = this.nextSid;
    return c;
  }
}
