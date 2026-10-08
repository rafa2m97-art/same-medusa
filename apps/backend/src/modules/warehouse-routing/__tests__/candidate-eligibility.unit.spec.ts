import {
  evaluateRoutingCandidateEligibility,
  type RoutingCandidateInput,
} from "../rules/candidate-eligibility"

const now = new Date("2026-10-03T12:00:00Z")
const ONE_HOUR_MS = 60 * 60 * 1000

function baseCandidate(overrides: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
  return {
    supplierStatus: "active",
    warehouseStatus: "active",
    mappingStatus: "active",
    supplierProductStateStatus: "active",
    inventoryConfirmedAt: now,
    ...overrides,
  }
}

describe("evaluateRoutingCandidateEligibility", () => {
  it("is eligible when supplier/warehouse/mapping are active, not quarantined, and inventory is fresh", () => {
    const result = evaluateRoutingCandidateEligibility(baseCandidate(), { maxInventoryAgeMs: ONE_HOUR_MS, now })
    expect(result).toEqual({ eligible: true })
  })

  it("rejects an inactive supplier", () => {
    const result = evaluateRoutingCandidateEligibility(baseCandidate({ supplierStatus: "inactive" }), {
      maxInventoryAgeMs: ONE_HOUR_MS,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "supplier_inactive" })
  })

  it("rejects an inactive warehouse", () => {
    const result = evaluateRoutingCandidateEligibility(baseCandidate({ warehouseStatus: "inactive" }), {
      maxInventoryAgeMs: ONE_HOUR_MS,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "warehouse_inactive" })
  })

  it("rejects an inactive mapping", () => {
    const result = evaluateRoutingCandidateEligibility(baseCandidate({ mappingStatus: "inactive" }), {
      maxInventoryAgeMs: ONE_HOUR_MS,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "mapping_inactive" })
  })

  it("rejects a quarantined mapping even with fresh inventory", () => {
    const result = evaluateRoutingCandidateEligibility(
      baseCandidate({ supplierProductStateStatus: "quarantined" }),
      { maxInventoryAgeMs: ONE_HOUR_MS, now }
    )
    expect(result).toEqual({ eligible: false, reason: "quarantined" })
  })

  it("rejects inventory older than the configured staleness window", () => {
    const result = evaluateRoutingCandidateEligibility(
      baseCandidate({ inventoryConfirmedAt: new Date(now.getTime() - 2 * ONE_HOUR_MS) }),
      { maxInventoryAgeMs: ONE_HOUR_MS, now }
    )
    expect(result).toEqual({ eligible: false, reason: "stale_inventory" })
  })

  it("rejects a candidate whose inventory was never confirmed", () => {
    const result = evaluateRoutingCandidateEligibility(baseCandidate({ inventoryConfirmedAt: null }), {
      maxInventoryAgeMs: ONE_HOUR_MS,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "stale_inventory" })
  })

  it("checks supplier status before any other reason (deterministic precedence)", () => {
    const result = evaluateRoutingCandidateEligibility(
      baseCandidate({ supplierStatus: "inactive", warehouseStatus: "inactive", mappingStatus: "inactive" }),
      { maxInventoryAgeMs: ONE_HOUR_MS, now }
    )
    expect(result.reason).toBe("supplier_inactive")
  })
})
