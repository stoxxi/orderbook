// packages/orderbook/__tests__/stp-falsy-userid.spec.ts
//
// Regression tests: UserSTPPolicy's "missing user context" fast path used
// `if (!makerUserId || !takerUserId)` — so the FALSY-but-valid user ids
// 0 and "" bypassed self-trade prevention entirely. The check must be
// `== null` (null/undefined only). Production user ids are non-empty
// strings today, but this is exported API surface.

import { describe, expect, it } from "bun:test";
import { Order } from "../src/order";
import { UserSTPPolicy } from "../src/orderBook";
import { Side } from "../src/types";

function orderFor(userId: unknown, orderId: string): Order<{ userId?: unknown }> {
  return new Order(orderId, Side.BUY, 100n, 10n, { userId });
}

describe("UserSTPPolicy falsy-but-valid userIds", () => {
  const policy = new UserSTPPolicy();

  it("prevents a self-trade when both sides have userId 0", () => {
    expect(policy.shouldPreventTrade(orderFor(0, "m"), orderFor(0, "t"))).toBe(true);
  });

  it('prevents a self-trade when both sides have userId ""', () => {
    expect(policy.shouldPreventTrade(orderFor("", "m"), orderFor("", "t"))).toBe(true);
  });

  it("still allows trades when either side lacks user context", () => {
    expect(policy.shouldPreventTrade(orderFor(null, "m"), orderFor(null, "t"))).toBe(false);
    expect(policy.shouldPreventTrade(orderFor(undefined, "m"), orderFor("u1", "t"))).toBe(false);
    expect(
      policy.shouldPreventTrade(
        new Order("m", Side.BUY, 100n, 10n), // userData null entirely
        orderFor("u1", "t"),
      ),
    ).toBe(false);
  });

  it("still allows trades between different falsy/non-falsy users", () => {
    expect(policy.shouldPreventTrade(orderFor(0, "m"), orderFor("", "t"))).toBe(false);
    expect(policy.shouldPreventTrade(orderFor("", "m"), orderFor("u1", "t"))).toBe(false);
    expect(policy.shouldPreventTrade(orderFor("u1", "m"), orderFor("u2", "t"))).toBe(false);
  });

  it("still prevents the normal same-user case", () => {
    expect(policy.shouldPreventTrade(orderFor("u1", "m"), orderFor("u1", "t"))).toBe(true);
  });
});
