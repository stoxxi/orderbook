// packages/orderbook/__tests__/idGenerator.spec.ts
//
// Unit tests for the IdGenerator + isValidSid predicate. Foundational —
// every invariant guard in the engine relies on these primitives, so the
// behavior is pinned at the lowest possible layer.

import { describe, expect, test } from "bun:test";
import { IdGenerator, isValidSid, type OrderSid } from "../src";

describe("IdGenerator", () => {
  describe("next()", () => {
    test("starts at 1 and increments monotonically", () => {
      const g = new IdGenerator();
      expect(g.next()).toBe(1n);
      expect(g.next()).toBe(2n);
      expect(g.next()).toBe(3n);
    });

    test("current() reflects the next-to-issue value, not the last issued", () => {
      const g = new IdGenerator();
      expect(g.current()).toBe(1n);
      g.next(); // returns 1, advances to 2
      expect(g.current()).toBe(2n);
      g.next(); // returns 2, advances to 3
      expect(g.current()).toBe(3n);
    });
  });

  describe("observe()", () => {
    test("advances past observed SID so subsequent next() is monotonic", () => {
      const g = new IdGenerator();
      g.observe(100n as OrderSid);
      expect(g.next()).toBe(101n);
    });

    test("does not regress when observing a smaller SID", () => {
      const g = new IdGenerator();
      g.observe(100n as OrderSid);
      g.observe(50n as OrderSid); // smaller — must not regress
      expect(g.next()).toBe(101n);
    });

    test("observing the current value still advances past it", () => {
      const g = new IdGenerator();
      // current = 1n, observe 1n → next must be > 1n
      g.observe(1n as OrderSid);
      expect(g.next()).toBe(2n);
    });

    test("repeated observes are idempotent (all bumps are monotonic)", () => {
      const g = new IdGenerator();
      g.observe(50n as OrderSid);
      g.observe(50n as OrderSid);
      g.observe(50n as OrderSid);
      expect(g.next()).toBe(51n);
    });
  });

  describe("advanceTo()", () => {
    test("advances when min > current", () => {
      const g = new IdGenerator();
      g.advanceTo(500n as OrderSid);
      expect(g.next()).toBe(500n);
    });

    test("does not regress when min < current", () => {
      const g = new IdGenerator();
      g.next(); // current advances to 2
      g.next(); // current advances to 3
      g.advanceTo(1n as OrderSid); // would regress
      expect(g.next()).toBe(3n); // protected
    });

    test("safe to call multiple times (monotonic semantics)", () => {
      const g = new IdGenerator();
      g.advanceTo(100n as OrderSid);
      g.advanceTo(50n as OrderSid);
      g.advanceTo(75n as OrderSid);
      g.advanceTo(200n as OrderSid);
      expect(g.next()).toBe(200n);
    });
  });

  describe("reset() (test-only)", () => {
    test("returns counter to 1n", () => {
      const g = new IdGenerator();
      g.next();
      g.next();
      g.next();
      g.reset();
      expect(g.next()).toBe(1n);
    });
  });

  describe("interaction: observe + next monotonicity", () => {
    test("interleaved observes and nexts stay monotonic", () => {
      const g = new IdGenerator();
      const issued: bigint[] = [];

      issued.push(g.next()); // 1
      g.observe(10n as OrderSid);
      issued.push(g.next()); // 11
      g.observe(5n as OrderSid); // no regression
      issued.push(g.next()); // 12
      g.observe(100n as OrderSid);
      issued.push(g.next()); // 101

      expect(issued).toEqual([1n, 11n, 12n, 101n]);
      // Strictly increasing
      for (let i = 1; i < issued.length; i++) {
        expect(issued[i] > issued[i - 1]).toBe(true);
      }
    });
  });
});

describe("isValidSid()", () => {
  test("accepts positive bigints", () => {
    expect(isValidSid(1n)).toBe(true);
    expect(isValidSid(42n)).toBe(true);
    expect(isValidSid(2n ** 53n)).toBe(true); // beyond Number.MAX_SAFE_INTEGER
    expect(isValidSid(123456789012345678901234567890n)).toBe(true);
  });

  test("rejects 0n (sentinel for unassigned)", () => {
    expect(isValidSid(0n)).toBe(false);
  });

  test("rejects negative bigints", () => {
    expect(isValidSid(-1n)).toBe(false);
    expect(isValidSid(-100n)).toBe(false);
  });

  test("rejects undefined / null (missing field)", () => {
    expect(isValidSid(undefined)).toBe(false);
    expect(isValidSid(null)).toBe(false);
  });

  test("rejects non-bigint numerics (serialization drift from JSON)", () => {
    expect(isValidSid(1)).toBe(false);
    expect(isValidSid(0)).toBe(false);
    expect(isValidSid(-1)).toBe(false);
    expect(isValidSid(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isValidSid(Number.NaN)).toBe(false);
    expect(isValidSid(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("rejects strings (msgpack/JSON round-trip drift)", () => {
    expect(isValidSid("1")).toBe(false);
    expect(isValidSid("123")).toBe(false);
    expect(isValidSid("")).toBe(false);
  });

  test("rejects other primitives and objects", () => {
    expect(isValidSid(true)).toBe(false);
    expect(isValidSid(false)).toBe(false);
    expect(isValidSid({})).toBe(false);
    expect(isValidSid([])).toBe(false);
    expect(isValidSid(Symbol("x"))).toBe(false);
  });

  test("type narrows correctly when used as a guard", () => {
    const candidate: unknown = 5n;
    if (isValidSid(candidate)) {
      // Inside this block, TypeScript should know candidate is OrderSid (bigint).
      // Compile-time check: arithmetic should work without further casts.
      const incremented = candidate + 1n;
      expect(incremented).toBe(6n);
    } else {
      throw new Error("expected isValidSid to narrow");
    }
  });
});

describe("IdGenerator.clone (PR1.2)", () => {
  test("clone of a fresh generator starts at the same SID as the original", () => {
    const orig = new IdGenerator();
    const cloned = orig.clone();
    expect(cloned.current()).toBe(orig.current());
  });

  test("clone preserves the cursor mid-sequence", () => {
    const orig = new IdGenerator();
    orig.next();
    orig.next();
    orig.next();
    const cloned = orig.clone();
    expect(cloned.current()).toBe(orig.current());
    expect(cloned.current()).toBe(4n); // next() advances post-increment from 1n
  });

  test("clone is independent — advancing one does not advance the other", () => {
    const orig = new IdGenerator();
    orig.next(); // → 1n; nextSid = 2n
    const cloned = orig.clone();

    cloned.next(); // → 2n on clone; clone's nextSid = 3n
    cloned.next(); // → 3n on clone; clone's nextSid = 4n

    // Original is untouched.
    expect(orig.current()).toBe(2n);
    expect(orig.next()).toBe(2n);

    // And vice versa: advancing original after clone doesn't bump the clone.
    expect(cloned.current()).toBe(4n);
  });

  test("clone preserves observed advances (post-replay state)", () => {
    const orig = new IdGenerator();
    orig.observe(100n); // simulate replaying a snapshot — cursor jumps forward
    const cloned = orig.clone();
    expect(cloned.current()).toBe(101n);
    expect(cloned.next()).toBe(101n);
  });

  test("clone preserves advanceTo state (cross-epoch DB seed)", () => {
    const orig = new IdGenerator();
    orig.advanceTo(50n);
    const cloned = orig.clone();
    expect(cloned.current()).toBe(50n);
  });
});
