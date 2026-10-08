import {
  evaluateLiveSupplierConfirmations,
  type SupplierConfirmationOutcome,
} from "../rules/live-supplier-confirmation"

describe("evaluateLiveSupplierConfirmations", () => {
  it("passes when every supplier confirms", () => {
    const outcomes: SupplierConfirmationOutcome[] = [
      { supplierId: "sup_exel", status: "CONFIRMED" },
      { supplierId: "sup_syscom", status: "CONFIRMED" },
    ]
    expect(evaluateLiveSupplierConfirmations(outcomes)).toEqual({ allConfirmed: true })
  })

  it("fails completely (never partially) when one of several suppliers rejects (plan §17)", () => {
    const outcomes: SupplierConfirmationOutcome[] = [
      { supplierId: "sup_exel", status: "CONFIRMED" },
      { supplierId: "sup_syscom", status: "REJECTED", reason: "sin stock" },
    ]
    const result = evaluateLiveSupplierConfirmations(outcomes)
    expect(result.allConfirmed).toBe(false)
    if (result.allConfirmed) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SUPPLIER_STOCK_REJECTED")
  })

  it("fails with SUPPLIER_UNAVAILABLE when a supplier times out", () => {
    const outcomes: SupplierConfirmationOutcome[] = [{ supplierId: "sup_exel", status: "TIMEOUT" }]
    const result = evaluateLiveSupplierConfirmations(outcomes)
    expect(result.allConfirmed).toBe(false)
    if (result.allConfirmed) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SUPPLIER_UNAVAILABLE")
  })

  it("fails with SUPPLIER_UNAVAILABLE when the circuit breaker was already open", () => {
    const outcomes: SupplierConfirmationOutcome[] = [{ supplierId: "sup_exel", status: "CIRCUIT_OPEN" }]
    const result = evaluateLiveSupplierConfirmations(outcomes)
    expect(result.allConfirmed).toBe(false)
    if (result.allConfirmed) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SUPPLIER_UNAVAILABLE")
  })

  it("prefers SUPPLIER_STOCK_REJECTED over SUPPLIER_UNAVAILABLE when both occur together, but reports all outcomes", () => {
    const outcomes: SupplierConfirmationOutcome[] = [
      { supplierId: "sup_exel", status: "REJECTED" },
      { supplierId: "sup_syscom", status: "TIMEOUT" },
    ]
    const result = evaluateLiveSupplierConfirmations(outcomes)
    expect(result.allConfirmed).toBe(false)
    if (result.allConfirmed) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("SUPPLIER_STOCK_REJECTED")
    expect(result.failure.details?.outcomes).toHaveLength(2)
  })
})
