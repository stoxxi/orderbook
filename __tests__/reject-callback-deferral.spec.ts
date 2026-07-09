// packages/orderbook/__tests__/reject-callback-deferral.spec.ts
//
// Regression tests: onCancelReject / onReplaceReject used to fire
// SYNCHRONOUSLY inside cancel()/replace()'s catch block, while
// isProcessing was still true — so a listener that re-entered the book
// from a reject callback hit the reentrancy guard (and the resulting
// OrderBookError was swallowed by safeInvokeCallback, silently dropping
// the re-entrant operation). All other listener callbacks (including
// add()'s onReject) are deferred via deferCallback and run from
// flushCallbacks() in the finally, after isProcessing=false.
//
// These tests pin the deferred behavior: the reject callback fires
// exactly once, re-entrant calls from it succeed, and the original
// OrderBookError still propagates to the caller.

import { describe, expect, it } from "bun:test";
import type { OrderListener } from "../src/listeners";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { OrderBookError } from "../src/errors";
import { Side } from "../src/types";
import type { OrderSid } from "../src/types";
import { helperAdd } from "./_helpers";

function noOpListener(): OrderListener {
  return {
    onAccept: () => {},
    onReject: () => {},
    onFill: () => {},
    onCancel: () => {},
    onCancelReject: () => {},
    onReplace: () => {},
    onReplaceReject: () => {},
  };
}

describe("reject callbacks are deferred (run after isProcessing=false)", () => {
  it("onCancelReject can re-enter book.cancel() for another live order", () => {
    const book = OrderBook.create("TEST", { pricePrecision: 2, quantityPrecision: 0 });

    const liveOrder = new Order("live-1", Side.BUY, book.toInternalPrice(100), 10n);
    helperAdd(book, liveOrder);
    const liveSid = liveOrder.serverOrderId as OrderSid;

    // Record callback ORDER, not just counts: the nested cancel's own
    // onCancel is deferred and must be drained by the OUTER flush (the
    // index-arithmetic property the isFlushing guard protects), i.e. after
    // the onCancelReject callback body that enqueued it has returned.
    const events: string[] = [];
    const listener = noOpListener();
    listener.onCancelReject = () => {
      events.push("cancelReject");
      // Re-enter the book from the reject callback. Must NOT hit the
      // reentrancy guard (the callback runs after isProcessing=false).
      book.cancel(liveSid);
      // The nested cancel's onCancel is deferred — it must NOT have fired
      // synchronously inside this callback (no nested drain).
      expect(events).toEqual(["cancelReject"]);
    };
    listener.onCancel = (snap) => {
      events.push(`cancel:${snap.orderId}`);
    };
    book.setOrderListener(listener);

    // Cancel a nonexistent order → OrderBookError(UnknownOrder) propagates,
    // and the listener fires (deferred, during the finally's flush).
    expect(() => book.cancel(999999999n as OrderSid)).toThrow(OrderBookError);

    // Each listener fired exactly once, in outer-drain order: the reject
    // callback first, then the nested cancel's onCancel (appended to the
    // SAME deferred queue and drained by the outer flush).
    expect(events).toEqual(["cancelReject", "cancel:live-1"]);
    // ... and the re-entrant cancel actually succeeded.
    expect(book.getOrder(liveSid)).toBeUndefined();
    expect(liveOrder.state).toBe(OrderState.CANCELED);
  });

  it("onReplaceReject can re-enter book.cancel() for another live order", () => {
    const book = OrderBook.create("TEST", { pricePrecision: 2, quantityPrecision: 0 });

    const liveOrder = new Order("live-2", Side.SELL, book.toInternalPrice(105), 5n);
    helperAdd(book, liveOrder);
    const liveSid = liveOrder.serverOrderId as OrderSid;

    const events: string[] = [];
    const listener = noOpListener();
    listener.onReplaceReject = () => {
      events.push("replaceReject");
      book.cancel(liveSid);
    };
    listener.onCancel = (snap) => {
      events.push(`cancel:${snap.orderId}`);
    };
    book.setOrderListener(listener);

    // Replace a nonexistent order → OrderBookError(UnknownOrder).
    expect(() =>
      book.replace(888888888n as OrderSid, 10n, book.toInternalPrice(106)),
    ).toThrow(OrderBookError);

    // Same outer-drain property as the cancel-side test: the nested cancel's
    // deferred onCancel fired exactly once, after the reject callback.
    expect(events).toEqual(["replaceReject", "cancel:live-2"]);
    expect(book.getOrder(liveSid)).toBeUndefined();
    expect(liveOrder.state).toBe(OrderState.CANCELED);
  });

  it("onCancelReject receives eagerly-captured code/message and fires before the caller's catch", () => {
    const book = OrderBook.create("TEST", { pricePrecision: 2, quantityPrecision: 0 });

    const seen: Array<{ orderId: string | null; code: number; text: string }> = [];
    const listener = noOpListener();
    listener.onCancelReject = (snap, code, text) => {
      seen.push({ orderId: snap?.orderId ?? null, code, text });
    };
    book.setOrderListener(listener);

    let caught: OrderBookError | null = null;
    try {
      book.cancel(123456789n as OrderSid);
    } catch (err) {
      caught = err as OrderBookError;
      // The deferred callback ran in the finally — BEFORE the exception
      // reached this catch (JS finally semantics).
      expect(seen).toHaveLength(1);
    }

    expect(caught).toBeInstanceOf(OrderBookError);
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe(caught!.code);
    expect(seen[0].text).toBe(caught!.message);
  });
});
