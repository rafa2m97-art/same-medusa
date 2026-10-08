import { evaluatePriceGuardLine } from "../rules/price-guard"

function baseInput() {
  return {
    variantId: "variant_1",
    cartUnitPrice: 123,
    authoritativeUnitPrice: 123,
    isCalculatedPriceTaxInclusive: true,
    lastPricingClassification: "ACCEPT" as const,
  }
}

describe("evaluatePriceGuardLine", () => {
  it("accepts when cart price matches the current authoritative tax-inclusive price", () => {
    expect(evaluatePriceGuardLine(baseInput())).toEqual({ valid: true, authoritativeUnitPrice: 123 })
  })

  it("rejects with PRICE_REQUIRES_REVIEW when Pricing itself flagged the variant as REVIEW", () => {
    const result = evaluatePriceGuardLine({ ...baseInput(), lastPricingClassification: "REVIEW" })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("PRICE_REQUIRES_REVIEW")
  })

  it("rejects with PRICE_INVALID when there is no authoritative price at all", () => {
    const result = evaluatePriceGuardLine({ ...baseInput(), authoritativeUnitPrice: null })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("PRICE_INVALID")
  })

  it("rejects with PRICE_INVALID for a non-finite authoritative price", () => {
    const result = evaluatePriceGuardLine({ ...baseInput(), authoritativeUnitPrice: NaN })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("PRICE_INVALID")
  })

  it("rejects with PRICE_INVALID for a zero or negative authoritative price", () => {
    const result = evaluatePriceGuardLine({ ...baseInput(), authoritativeUnitPrice: 0 })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("PRICE_INVALID")
  })

  it("rejects with PRICE_INVALID (regression guard, Etapa 5 §44) when the price is not tax-inclusive", () => {
    const result = evaluatePriceGuardLine({ ...baseInput(), isCalculatedPriceTaxInclusive: false })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("PRICE_INVALID")
    expect(result.failure.details).toMatchObject({ reason: "not_tax_inclusive" })
  })

  it("rejects with PRICE_CHANGED (never silently charging the stale cart price) when the authoritative price legitimately moved", () => {
    const result = evaluatePriceGuardLine({ ...baseInput(), cartUnitPrice: 1000, authoritativeUnitPrice: 1050 })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("PRICE_CHANGED")
    expect(result.failure.details).toMatchObject({ cartUnitPrice: 1000, authoritativeUnitPrice: 1050 })
  })
})
