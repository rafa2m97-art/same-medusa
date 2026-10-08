import { evaluateAddressCompleteness } from "../rules/address-guard"

function completeAddress() {
  return {
    address1: "Av. Siempre Viva 123",
    city: "Monterrey",
    province: "NLE",
    postalCode: "64000",
    countryCode: "mx",
    phone: "8112345678",
  }
}

describe("evaluateAddressCompleteness", () => {
  it("passes a fully complete address", () => {
    expect(evaluateAddressCompleteness(completeAddress())).toEqual({ valid: true })
  })

  it("fails with ADDRESS_INCOMPLETE when street is missing", () => {
    const result = evaluateAddressCompleteness({ ...completeAddress(), address1: null })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("ADDRESS_INCOMPLETE")
    expect(result.failure.details).toMatchObject({ missingFields: ["address1"] })
  })

  it("fails when postal code or state are blank (whitespace-only), matching Envia's real hard requirement", () => {
    const result = evaluateAddressCompleteness({ ...completeAddress(), postalCode: "   ", province: "" })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.details).toMatchObject({ missingFields: ["province", "postalCode"] })
  })

  it("requires phone by default (WooCommerce's real default)", () => {
    const result = evaluateAddressCompleteness({ ...completeAddress(), phone: null })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.details).toMatchObject({ missingFields: ["phone"] })
  })

  it("allows phone to be skipped when phoneRequired is explicitly false (store-configurable, never hardcoded)", () => {
    const result = evaluateAddressCompleteness({ ...completeAddress(), phone: null }, { phoneRequired: false })
    expect(result).toEqual({ valid: true })
  })

  it("reports every missing field at once, not just the first", () => {
    const result = evaluateAddressCompleteness({
      address1: null,
      city: null,
      province: null,
      postalCode: null,
      countryCode: null,
      phone: null,
    })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.details?.missingFields).toEqual([
      "address1",
      "city",
      "province",
      "postalCode",
      "countryCode",
      "phone",
    ])
  })
})
