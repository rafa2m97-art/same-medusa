import { evaluateShippingQuote, type ShippingQuoteInput } from "../rules/shipping-quote-guard"

const now = new Date("2026-10-03T12:00:00Z")

function validQuote(overrides: Partial<ShippingQuoteInput> = {}): ShippingQuoteInput {
  return {
    status: "active",
    expiresAt: new Date("2026-10-03T12:30:00Z"),
    allocationSnapshotId: "as_1",
    amount: 150,
    currencyCode: "mxn",
    isFreeShipping: false,
    ...overrides,
  }
}

function baseGuardInput(quote: ShippingQuoteInput | null) {
  return {
    quote,
    currentAllocationSnapshotId: "as_1",
    cartCurrencyCode: "mxn",
    now,
  }
}

describe("evaluateShippingQuote", () => {
  it("passes a valid, active, positive-amount quote tied to the current allocation", () => {
    expect(evaluateShippingQuote(baseGuardInput(validQuote()))).toEqual({ valid: true, amount: 150 })
  })

  it("fails with SHIPPING_QUOTE_MISSING when there is no quote at all", () => {
    const result = evaluateShippingQuote(baseGuardInput(null))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_MISSING")
  })

  it("fails with SHIPPING_QUOTE_MISSING when the quote was already consumed by another checkout attempt", () => {
    const result = evaluateShippingQuote(baseGuardInput(validQuote({ status: "consumed" })))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_MISSING")
  })

  it("fails with SHIPPING_QUOTE_EXPIRED when the status is expired", () => {
    const result = evaluateShippingQuote(baseGuardInput(validQuote({ status: "expired" })))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_EXPIRED")
  })

  it("fails with SHIPPING_QUOTE_EXPIRED when now has passed expires_at even if status is still active", () => {
    const result = evaluateShippingQuote(
      baseGuardInput(validQuote({ expiresAt: new Date("2026-10-03T11:00:00Z") }))
    )
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_EXPIRED")
  })

  it("fails with SHIPPING_QUOTE_ALLOCATION_MISMATCH when the quote was computed for a different allocation", () => {
    const result = evaluateShippingQuote(baseGuardInput(validQuote({ allocationSnapshotId: "as_2" })))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_ALLOCATION_MISMATCH")
  })

  it("fails with SHIPPING_QUOTE_CURRENCY_MISMATCH when the quote currency differs from the cart's", () => {
    const result = evaluateShippingQuote({
      ...baseGuardInput(validQuote({ currencyCode: "usd" })),
      cartCurrencyCode: "mxn",
    })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_CURRENCY_MISMATCH")
  })

  it("fails with SHIPPING_QUOTE_MISSING for a null amount without an explicit free-shipping flag (never defaults to $0)", () => {
    const result = evaluateShippingQuote(baseGuardInput(validQuote({ amount: null, isFreeShipping: false })))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_MISSING")
  })

  it("fails with SHIPPING_QUOTE_MISSING for a zero amount without an explicit free-shipping flag", () => {
    const result = evaluateShippingQuote(baseGuardInput(validQuote({ amount: 0, isFreeShipping: false })))
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SHIPPING_QUOTE_MISSING")
  })

  it("passes a $0 amount when isFreeShipping is explicitly true", () => {
    expect(evaluateShippingQuote(baseGuardInput(validQuote({ amount: 0, isFreeShipping: true })))).toEqual({
      valid: true,
      amount: 0,
    })
  })

  it("passes a positive amount even when isFreeShipping happens to be true", () => {
    expect(
      evaluateShippingQuote(baseGuardInput(validQuote({ amount: 99, isFreeShipping: true })))
    ).toEqual({ valid: true, amount: 99 })
  })
})
