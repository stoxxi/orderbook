// tests/orderBook.spec.ts

import { beforeEach, describe, expect, it, vi } from "bun:test";
import { helperAdd } from "./_helpers";
import { noOpLogger } from "../src/logging";
import { noOpMetrics } from "../src/metrics";
import { createInstrument, Instrument, toCanonicalDecimal } from "../src/instrument";
import { OrderListener } from "../src/listeners";
import { Order, OrderState } from "../src/order";
import { OrderBook } from "../src/orderBook";
import { OrderRejectReason } from "../src/reasons";
import { TradeSnapshot } from "../src/trade";
import { Quantity, Side } from "../src/types";

// =============================================================================
// MOCKS & SETUP
// =============================================================================

// Use the actual interfaces to ensure our mock is type-safe
const mockOrderListener: OrderListener = {
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onFill: vi.fn(),
  onCancel: vi.fn(),
  onCancelReject: vi.fn(),
  onReplace: vi.fn(),
  onReplaceReject: vi.fn(),
};

const mockTradeListener = { onTrade: vi.fn() };
const mockBboListener = { onBboChange: vi.fn() };
const mockDepthListener = { onDepthChange: vi.fn() };

describe("OrderBook", () => {
  // FIX: The type error was caused by `OrderBook<Order>`.
  // The correct type uses the default generic parameter `TUserData = unknown`,
  // which matches the `new Order(...)` calls that create `Order<unknown>`.
  let orderBook: OrderBook;
  let instrument: Instrument;

  beforeEach(() => {
    vi.clearAllMocks();
    instrument = createInstrument(
      "TEST",
      2,
      0,
      toCanonicalDecimal("0.01", 2), // tickSize
      toCanonicalDecimal("0.01", 2), // minPrice
      toCanonicalDecimal("1000000.00", 2), // maxPrice
    );
    orderBook = new OrderBook(instrument, noOpLogger, noOpMetrics);
    orderBook.setOrderListener(mockOrderListener);
    orderBook.setTradeListener(mockTradeListener);
    orderBook.setBboListener(mockBboListener);
    orderBook.setDepthListener(mockDepthListener);
  });

  // ... (assuming other describe blocks exist and are correct) ...

  describe("Complex Matching Scenarios", () => {
    it("should sweep multiple price levels with one large taker order", () => {
      const sell1 = new Order("sell1", Side.SELL, 10100n, 10n);
      const sell2 = new Order("sell2", Side.SELL, 10200n, 10n);
      const sell3 = new Order("sell3", Side.SELL, 10300n, 10n);
      helperAdd(orderBook, sell1);
      helperAdd(orderBook, sell2);
      helperAdd(orderBook, sell3);

      const takerBuy = new Order("taker-buy", Side.BUY, 10300n, 25n);
      helperAdd(orderBook, takerBuy);

      // --- Assert Final States ---
      // WRONG: Do not check the state of the original objects. They are stale.
      // expect(sell1.state).toBe(OrderState.FILLED);

      // RIGHT: Assert on the snapshots passed to the mock listeners.
      // This verifies the true final state of each order.
      expect(mockOrderListener.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "sell1",
          state: OrderState.FILLED,
          openQuantity: 0n,
        }),
        expect.any(Object),
      );
      expect(mockOrderListener.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "sell2",
          state: OrderState.FILLED,
          openQuantity: 0n,
        }),
        expect.any(Object),
      );
      expect(mockOrderListener.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "sell3",
          state: OrderState.PARTIALLY_FILLED,
          openQuantity: 5n,
        }),
        expect.any(Object),
      );
      expect(mockOrderListener.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "taker-buy",
          state: OrderState.FILLED,
          openQuantity: 0n,
        }),
        expect.any(Object),
      );

      // --- Assert Trade Events ---
      expect(mockTradeListener.onTrade).toHaveBeenCalledTimes(3);
      // Check that the first trade was against the best price
      expect(mockTradeListener.onTrade).toHaveBeenCalledWith(
        orderBook,
        expect.objectContaining({
          makingOrderId: "sell1",
          takingOrderId: "taker-buy",
          matchPrice: 10100n,
          matchQuantity: 10n,
        }),
      );
    });

    it("should replace an order making it aggressive and causing an immediate match", () => {
      // Arrange
      const buyOrder = new Order("buy-replace", Side.BUY, 10000n, 10n);
      const sellOrder = new Order("sell-resting", Side.SELL, 10200n, 10n);
      helperAdd(orderBook, buyOrder);
      helperAdd(orderBook, sellOrder);
      vi.clearAllMocks();

      // Act
      // FIX: The operation is synchronous. No `async/await` is needed.
      orderBook.replace(buyOrder.serverOrderId!, 10n, 10200n);

      // Assert
      expect(mockOrderListener.onReplace).toHaveBeenCalledTimes(1);
      expect(mockTradeListener.onTrade).toHaveBeenCalledTimes(1);

      // RIGHT: Assert final states via the mock listener calls.
      expect(mockOrderListener.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "buy-replace",
          state: OrderState.FILLED,
        }),
        expect.any(Object),
      );
      expect(mockOrderListener.onFill).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "sell-resting",
          state: OrderState.FILLED,
        }),
        expect.any(Object),
      );
    });

    it("should reject replace with invalid tick size", () => {
      // FIX: Use the default generic for `create`
      const book = OrderBook.create("TEST", { tickSize: "5" });
      book.setOrderListener(mockOrderListener);
      const order = new Order("o1", Side.BUY, 10000n, 10n);
      helperAdd(book, order);

      expect(() => book.replace(order.serverOrderId!, 10n, 10003n)).toThrowError(/tick size/i);

      // FIX: The listener receives a snapshot, not the original order instance.
      // Use `expect.objectContaining` to check key properties.
      expect(mockOrderListener.onReplaceReject).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "o1" }),
        OrderRejectReason.InvalidTickSize,
        expect.stringContaining("tick size"),
      );
    });
  });

  describe("Event Sequencing", () => {
    it("should call onTrade listener AFTER both order states are updated", () => {
      const makerOrder = new Order("maker1", Side.SELL, 10000n, 100n);
      helperAdd(orderBook, makerOrder);

      const makerInitialQty = makerOrder.openQuantity;
      let makerQtyOnTrade: Quantity | null = null;
      let takerQtyOnTrade: Quantity | null = null;

      // Use mockImplementation to capture state AT THE MOMENT the event fires
      mockTradeListener.onTrade.mockImplementation((book: OrderBook, _trade: TradeSnapshot) => {
        // HFT Logic: We access the objects directly via reference.
        // We do NOT use book.getOrder() because the engine removes fully filled
        // orders from its internal map immediately to save memory.
        makerQtyOnTrade = makerOrder.openQuantity;
        takerQtyOnTrade = takerOrder.openQuantity;
      });

      const takerOrder = new Order("taker1", Side.BUY, 10000n, 40n);
      helperAdd(orderBook, takerOrder);

      // Assert that the listener was called
      expect(makerQtyOnTrade).not.toBeNull();
      expect(takerQtyOnTrade).not.toBeNull();

      // The crucial assertion: The quantities seen by the listener must be the post-trade quantities.
      const expectedMakerQty = makerInitialQty - 40n; // 100 - 40 = 60
      expect(makerQtyOnTrade!).toBe(expectedMakerQty);
      expect(takerQtyOnTrade!).toBe(0n); // Taker order should be fully filled
    });
  });
});
