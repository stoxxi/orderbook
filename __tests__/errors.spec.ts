// packages/orderbook/__tests__/errors.spec.ts
// P3: Error Classes and Utilities Tests
//
// Tests for custom error classes and rejection reason utilities.

import { describe, test, expect } from "bun:test";
import { OrderBookError, FatalEngineError } from "../src/errors";
import { OrderRejectReason, getOrderRejectReasonText } from "../src/reasons";

describe("OrderBookError", () => {
  describe("Construction", () => {
    test("should create error with code and message", () => {
      const error = new OrderBookError(
        OrderRejectReason.UnknownOrder,
        "Order not found"
      );

      expect(error.code).toBe(OrderRejectReason.UnknownOrder);
      expect(error.message).toBe("Order not found");
      expect(error.name).toBe("OrderBookError");
    });

    test("should be instanceof Error", () => {
      const error = new OrderBookError(
        OrderRejectReason.InvalidPrice,
        "Invalid price"
      );

      expect(error instanceof Error).toBe(true);
      expect(error instanceof OrderBookError).toBe(true);
    });

    test("should have stack trace", () => {
      const error = new OrderBookError(
        OrderRejectReason.Other,
        "Test error"
      );

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("OrderBookError");
    });
  });

  describe("toString", () => {
    test("should format error with code", () => {
      const error = new OrderBookError(
        OrderRejectReason.UnknownOrder,
        "Order 123 not found"
      );

      const str = error.toString();

      expect(str).toContain("OrderBookError");
      expect(str).toContain(String(OrderRejectReason.UnknownOrder));
      expect(str).toContain("Order 123 not found");
    });

    test("should format with custom codes", () => {
      const error = new OrderBookError(
        OrderRejectReason.InvalidPrice,
        "Price must be positive"
      );

      expect(error.toString()).toBe(
        `OrderBookError (${OrderRejectReason.InvalidPrice}): Price must be positive`
      );
    });
  });

  describe("Error Codes", () => {
    test("should preserve UnknownSymbol code", () => {
      const error = new OrderBookError(
        OrderRejectReason.UnknownSymbol,
        "Symbol not found"
      );
      expect(error.code).toBe(100);
    });

    test("should preserve MarketClosed code", () => {
      const error = new OrderBookError(
        OrderRejectReason.MarketClosed,
        "Market is closed"
      );
      expect(error.code).toBe(101);
    });

    test("should preserve custom codes", () => {
      const error = new OrderBookError(
        OrderRejectReason.InvalidTickSize,
        "Invalid tick"
      );
      expect(error.code).toBe(9902);
    });
  });
});

describe("FatalEngineError", () => {
  describe("Construction", () => {
    test("should create error with message", () => {
      const error = new FatalEngineError("WAL corruption detected");

      expect(error.message).toBe("WAL corruption detected");
      expect(error.name).toBe("FatalEngineError");
    });

    test("should be instanceof Error", () => {
      const error = new FatalEngineError("Fatal error");

      expect(error instanceof Error).toBe(true);
      expect(error instanceof FatalEngineError).toBe(true);
    });

    test("should NOT be instanceof OrderBookError", () => {
      const error = new FatalEngineError("Fatal");

      expect(error instanceof OrderBookError).toBe(false);
    });

    test("should have stack trace", () => {
      const error = new FatalEngineError("Test fatal");

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("FatalEngineError");
    });
  });

  describe("Usage Pattern", () => {
    test("should be catchable separately from OrderBookError", () => {
      const fatalError = new FatalEngineError("Fatal");
      const bookError = new OrderBookError(OrderRejectReason.Other, "Book");

      let caughtFatal = false;
      let caughtBook = false;

      try {
        throw fatalError;
      } catch (e) {
        if (e instanceof FatalEngineError) {
          caughtFatal = true;
        } else if (e instanceof OrderBookError) {
          caughtBook = true;
        }
      }

      expect(caughtFatal).toBe(true);
      expect(caughtBook).toBe(false);
    });
  });
});

describe("getOrderRejectReasonText", () => {
  describe("FIX Protocol Codes", () => {
    test("should return text for UnknownOrder (5)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.UnknownOrder)).toBe(
        "Unknown order"
      );
    });

    test("should return text for DuplicateOrder (6)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.DuplicateOrder)).toBe(
        "Duplicate order"
      );
    });

    test("should return text for IncorrectQuantity (13)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.IncorrectQuantity)).toBe(
        "Incorrect quantity"
      );
    });

    test("should return text for InvalidInvestorID (18)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.InvalidInvestorID)).toBe(
        "Unknown User"
      );
    });
  });

  describe("Exchange-Level Codes", () => {
    test("should return text for UnknownSymbol (100)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.UnknownSymbol)).toBe(
        "Unknown symbol"
      );
    });

    test("should return text for MarketClosed (101)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.MarketClosed)).toBe(
        "market closed"
      );
    });

    test("should return text for UserContextRequired (103)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.UserContextRequired)).toBe(
        "User context is missing from the order"
      );
    });
  });

  describe("Custom Codes", () => {
    test("should return text for OrderAlreadyFilled (9903)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.OrderAlreadyFilled)).toBe(
        "Cannot modify a fully filled order"
      );
    });

    test("should return text for QtyLessThanFilled (9904)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.QtyLessThanFilled)).toBe(
        "Quantity cannot be less than filled quantity"
      );
    });

    test("should return text for QtyMustBePositive (9905)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.QtyMustBePositive)).toBe(
        "Quantity must be positive; use cancel() to remove order"
      );
    });

    test("should return text for NoChange (9906)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.NoChange)).toBe(
        "No changes made in replace request"
      );
    });

    test("should return text for ConsistencyError (9907)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.ConsistencyError)).toBe(
        "Order consistency error"
      );
    });
  });

  describe("Default Case", () => {
    test("should return default text for Other (99)", () => {
      expect(getOrderRejectReasonText(OrderRejectReason.Other)).toBe(
        "Other or unknown reason"
      );
    });

    test("should return default text for unknown codes", () => {
      // Cast to bypass TypeScript enum check
      expect(getOrderRejectReasonText(99999 as OrderRejectReason)).toBe(
        "Other or unknown reason"
      );
    });
  });

  describe("All Enum Values Coverage", () => {
    test("should have text for all OrderRejectReason values", () => {
      // Get all numeric enum values
      const enumValues = Object.values(OrderRejectReason).filter(
        (v) => typeof v === "number"
      ) as OrderRejectReason[];

      for (const code of enumValues) {
        const text = getOrderRejectReasonText(code);
        expect(text).toBeDefined();
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("OrderRejectReason Enum", () => {
  test("should have correct FIX protocol codes", () => {
    expect(OrderRejectReason.UnknownOrder).toBe(5);
    expect(OrderRejectReason.DuplicateOrder).toBe(6);
    expect(OrderRejectReason.IncorrectQuantity).toBe(13);
    expect(OrderRejectReason.InvalidInvestorID).toBe(18);
  });

  test("should have correct exchange-level codes", () => {
    expect(OrderRejectReason.UnknownSymbol).toBe(100);
    expect(OrderRejectReason.MarketClosed).toBe(101);
    expect(OrderRejectReason.UserContextRequired).toBe(103);
  });

  test("should have correct custom codes in 99xx range", () => {
    expect(OrderRejectReason.Other).toBe(99);
    expect(OrderRejectReason.InvalidPrice).toBe(9901);
    expect(OrderRejectReason.InvalidTickSize).toBe(9902);
    expect(OrderRejectReason.OrderAlreadyFilled).toBe(9903);
    expect(OrderRejectReason.QtyLessThanFilled).toBe(9904);
    expect(OrderRejectReason.QtyMustBePositive).toBe(9905);
    expect(OrderRejectReason.NoChange).toBe(9906);
    expect(OrderRejectReason.ConsistencyError).toBe(9907);
  });
});
