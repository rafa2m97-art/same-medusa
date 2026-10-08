import { resolveFailureRetryability, type CheckoutFailureCode } from "../rules/taxonomy"

const ALL_CODES: CheckoutFailureCode[] = [
  "CART_CHANGED",
  "ALLOCATION_EXPIRED",
  "ALLOCATION_INVALID",
  "PRICE_CHANGED",
  "PRICE_INVALID",
  "PRICE_REQUIRES_REVIEW",
  "LOCAL_STOCK_CHANGED",
  "RESERVATION_FAILED",
  "SUPPLIER_STOCK_REJECTED",
  "SUPPLIER_UNAVAILABLE",
  "ADDRESS_INCOMPLETE",
  "SHIPPING_QUOTE_MISSING",
  "SHIPPING_QUOTE_EXPIRED",
  "SHIPPING_QUOTE_ALLOCATION_MISMATCH",
  "SHIPPING_QUOTE_CURRENCY_MISMATCH",
]

describe("resolveFailureRetryability", () => {
  it("has a profile for every known failure code", () => {
    for (const code of ALL_CODES) {
      expect(resolveFailureRetryability(code)).toEqual(
        expect.objectContaining({
          retryable: expect.any(Boolean),
          requiresReallocation: expect.any(Boolean),
          customerActionRequired: expect.any(Boolean),
        })
      )
    }
  })

  it("marks a cart change as requiring reallocation, never a blind retry", () => {
    expect(resolveFailureRetryability("CART_CHANGED")).toEqual({
      retryable: false,
      requiresReallocation: true,
      customerActionRequired: false,
    })
  })

  it("marks a supplier timeout/unavailability as retryable without reallocation", () => {
    expect(resolveFailureRetryability("SUPPLIER_UNAVAILABLE")).toEqual({
      retryable: true,
      requiresReallocation: false,
      customerActionRequired: false,
    })
  })

  it("marks an incomplete address as requiring customer action, never an automatic retry", () => {
    expect(resolveFailureRetryability("ADDRESS_INCOMPLETE")).toEqual({
      retryable: false,
      requiresReallocation: false,
      customerActionRequired: true,
    })
  })

  it("marks a legitimate price change as requiring customer action, not a hard block retry", () => {
    expect(resolveFailureRetryability("PRICE_CHANGED")).toEqual({
      retryable: false,
      requiresReallocation: false,
      customerActionRequired: true,
    })
  })

  it("marks supplier stock rejection as requiring reallocation", () => {
    expect(resolveFailureRetryability("SUPPLIER_STOCK_REJECTED")).toEqual({
      retryable: false,
      requiresReallocation: true,
      customerActionRequired: false,
    })
  })
})
