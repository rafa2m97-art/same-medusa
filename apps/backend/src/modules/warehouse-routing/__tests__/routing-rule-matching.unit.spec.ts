import { resolveConfiguredPriority, type RoutingRuleEntry } from "../rules/routing-rule-matching"

const rules: RoutingRuleEntry[] = [
  { destinationState: "NL", supplierId: "sup_exel", supplierWarehouseId: "wh_my", priority: 0, status: "active" },
  { destinationState: "NL", supplierId: "sup_syscom", supplierWarehouseId: "wh_mty", priority: 1, status: "active" },
  { destinationState: "JAL", supplierId: "sup_exel", supplierWarehouseId: "wh_gd", priority: 0, status: "inactive" },
]

describe("resolveConfiguredPriority", () => {
  it("returns the configured priority for a matching active rule", () => {
    expect(
      resolveConfiguredPriority("NL", rules, { supplierId: "sup_exel", supplierWarehouseId: "wh_my" })
    ).toBe(0)
  })

  it("distinguishes multiple candidates ranked for the same destination", () => {
    expect(
      resolveConfiguredPriority("NL", rules, { supplierId: "sup_syscom", supplierWarehouseId: "wh_mty" })
    ).toBe(1)
  })

  it("normalizes destination casing/whitespace before matching", () => {
    expect(
      resolveConfiguredPriority(" nl ", rules, { supplierId: "sup_exel", supplierWarehouseId: "wh_my" })
    ).toBe(0)
  })

  it("returns null when no rule mentions this exact candidate for the destination", () => {
    expect(
      resolveConfiguredPriority("NL", rules, { supplierId: "sup_exel", supplierWarehouseId: "wh_gd" })
    ).toBeNull()
  })

  it("returns null when destination is null", () => {
    expect(
      resolveConfiguredPriority(null, rules, { supplierId: "sup_exel", supplierWarehouseId: "wh_my" })
    ).toBeNull()
  })

  it("ignores inactive rules", () => {
    expect(
      resolveConfiguredPriority("JAL", rules, { supplierId: "sup_exel", supplierWarehouseId: "wh_gd" })
    ).toBeNull()
  })

  it("never invents a priority for an unrelated destination", () => {
    expect(
      resolveConfiguredPriority("CDMX", rules, { supplierId: "sup_exel", supplierWarehouseId: "wh_my" })
    ).toBeNull()
  })
})
