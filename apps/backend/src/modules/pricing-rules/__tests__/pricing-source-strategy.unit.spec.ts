import {
  evaluateCandidateEligibility,
  PrimarySupplierStrategy,
  type PricingSourceCandidate,
} from "../rules/pricing-source-strategy"

const NOW = new Date("2026-10-03T12:00:00Z")
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function exelCandidate(overrides: Partial<PricingSourceCandidate> = {}): PricingSourceCandidate {
  return {
    supplierId: "supplier_exel",
    supplierCode: "exel_del_norte",
    mappingId: "mapping_exel",
    isPrimaryPricingSource: true,
    supplierStatus: "active",
    mappingStatus: "active",
    supplierProductStateStatus: null,
    costAmount: 100,
    costCurrencyCode: "mxn",
    costEffectiveAt: NOW,
    ...overrides,
  }
}

function syscomCandidate(overrides: Partial<PricingSourceCandidate> = {}): PricingSourceCandidate {
  return {
    supplierId: "supplier_syscom",
    supplierCode: "syscom",
    mappingId: "mapping_syscom",
    isPrimaryPricingSource: false,
    supplierStatus: "active",
    mappingStatus: "active",
    supplierProductStateStatus: null,
    costAmount: 90,
    costCurrencyCode: "mxn",
    costEffectiveAt: NOW,
    ...overrides,
  }
}

const ELIGIBILITY_OPTIONS = { requiredCurrencyCode: "mxn", maxCostAgeMs: 7 * ONE_DAY_MS, now: NOW }

describe("evaluateCandidateEligibility — validity/trust, nunca fulfillment optimization", () => {
  it("un candidato sano es elegible", () => {
    const result = evaluateCandidateEligibility(exelCandidate(), ELIGIBILITY_OPTIONS)
    expect(result.eligible).toEqual(true)
  })

  it("supplier inactivo -> inelegible, reason explícito", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ supplierStatus: "inactive" }),
      ELIGIBILITY_OPTIONS
    )
    expect(result).toMatchObject({ eligible: false, ineligibilityReason: "supplier_inactive" })
  })

  it("mapping inactivo -> inelegible", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ mappingStatus: "inactive" }),
      ELIGIBILITY_OPTIONS
    )
    expect(result).toMatchObject({ eligible: false, ineligibilityReason: "mapping_inactive" })
  })

  it("quarantined -> inelegible", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ supplierProductStateStatus: "quarantined" }),
      ELIGIBILITY_OPTIONS
    )
    expect(result).toMatchObject({ eligible: false, ineligibilityReason: "quarantined" })
  })

  it("sin SupplierCost todavía -> inelegible missing_cost", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ costAmount: null, costCurrencyCode: null, costEffectiveAt: null }),
      ELIGIBILITY_OPTIONS
    )
    expect(result).toMatchObject({ eligible: false, ineligibilityReason: "missing_cost" })
  })

  it("costo negativo/NaN -> inelegible invalid_cost", () => {
    expect(
      evaluateCandidateEligibility(exelCandidate({ costAmount: -5 }), ELIGIBILITY_OPTIONS)
    ).toMatchObject({ eligible: false, ineligibilityReason: "invalid_cost" })
    expect(
      evaluateCandidateEligibility(exelCandidate({ costAmount: NaN }), ELIGIBILITY_OPTIONS)
    ).toMatchObject({ eligible: false, ineligibilityReason: "invalid_cost" })
  })

  it("moneda no soportada -> inelegible unsupported_currency", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ costCurrencyCode: "usd" }),
      ELIGIBILITY_OPTIONS
    )
    expect(result).toMatchObject({ eligible: false, ineligibilityReason: "unsupported_currency" })
  })

  it("costo stale (más viejo que el máximo permitido) -> inelegible stale_cost", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ costEffectiveAt: new Date(NOW.getTime() - 10 * ONE_DAY_MS) }),
      ELIGIBILITY_OPTIONS
    )
    expect(result).toMatchObject({ eligible: false, ineligibilityReason: "stale_cost" })
  })

  it("costo fresco (dentro del máximo permitido) sigue elegible", () => {
    const result = evaluateCandidateEligibility(
      exelCandidate({ costEffectiveAt: new Date(NOW.getTime() - ONE_DAY_MS) }),
      ELIGIBILITY_OPTIONS
    )
    expect(result.eligible).toEqual(true)
  })
})

describe("PrimarySupplierStrategy — determinista, sin 'if supplierCode === EXEL'", () => {
  const strategy = new PrimarySupplierStrategy()

  function evaluateAll(candidates: PricingSourceCandidate[]) {
    return candidates.map((c) => evaluateCandidateEligibility(c, ELIGIBILITY_OPTIONS))
  }

  // 4. PRIMARY_SUPPLIER selecciona EXEL cuando es elegible.
  it("selecciona el candidato marcado is_primary_pricing_source, sin importar el orden de la lista", () => {
    const candidates = [syscomCandidate(), exelCandidate()]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection).toMatchObject({
      strategy: "PRIMARY_SUPPLIER",
      reason: "primary_selected",
    })
    expect(selection.selected?.supplierCode).toEqual("exel_del_norte")
  })

  // 5/18. la selección es determinista -- mismo set de candidatos, mismo resultado sin importar el orden.
  it("el orden de los candidatos en el arreglo no cambia el resultado", () => {
    const a = strategy.selectSource(evaluateAll([exelCandidate(), syscomCandidate()]))
    const b = strategy.selectSource(evaluateAll([syscomCandidate(), exelCandidate()]))
    expect(a).toEqual(b)
  })

  // 20. candidate no elegible tiene reason explícito, y NINGÚN otro proveedor gana automáticamente.
  it("primario inelegible (quarantined) -> no selecciona a NADIE, aunque Syscom sí sea elegible", () => {
    const candidates = [
      exelCandidate({ supplierProductStateStatus: "quarantined" }),
      syscomCandidate(),
    ]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection).toEqual({ strategy: "PRIMARY_SUPPLIER", selected: null, reason: "quarantined" })
  })

  it("primario inactivo -> no selecciona a nadie", () => {
    const candidates = [exelCandidate({ supplierStatus: "inactive" }), syscomCandidate()]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection.selected).toBeNull()
    expect(selection.reason).toEqual("supplier_inactive")
  })

  it("primario sin SupplierCost -> no selecciona a nadie (conserva Last Known Good aguas arriba)", () => {
    const candidates = [exelCandidate({ costAmount: null, costCurrencyCode: null }), syscomCandidate()]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection.selected).toBeNull()
    expect(selection.reason).toEqual("missing_cost")
  })

  it("primario con currency inválida -> no selecciona a nadie", () => {
    const candidates = [exelCandidate({ costCurrencyCode: "usd" }), syscomCandidate()]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection.reason).toEqual("unsupported_currency")
  })

  it("ningún proveedor marcado como primario -> primary_not_configured", () => {
    const candidates = [
      exelCandidate({ isPrimaryPricingSource: false }),
      syscomCandidate({ isPrimaryPricingSource: false }),
    ]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection).toEqual({ strategy: "PRIMARY_SUPPLIER", selected: null, reason: "primary_not_configured" })
  })

  // 26. Syscom funciona como candidato sin ningún adapter/integración real.
  it("Syscom participa como candidato puramente de datos, sin ningún SyscomAdapter", () => {
    const candidates = [syscomCandidate({ isPrimaryPricingSource: true }), exelCandidate({ isPrimaryPricingSource: false })]
    const selection = strategy.selectSource(evaluateAll(candidates))
    expect(selection.selected?.supplierCode).toEqual("syscom")
  })

  // 12. cambiar el primario (EXEL -> SYSCOM) selecciona el nuevo primario de inmediato.
  it("cambiar cuál candidato es primario cambia la selección sin tocar la estrategia", () => {
    const beforeChange = strategy.selectSource(
      evaluateAll([exelCandidate({ isPrimaryPricingSource: true }), syscomCandidate({ isPrimaryPricingSource: false })])
    )
    const afterChange = strategy.selectSource(
      evaluateAll([exelCandidate({ isPrimaryPricingSource: false }), syscomCandidate({ isPrimaryPricingSource: true })])
    )
    expect(beforeChange.selected?.supplierCode).toEqual("exel_del_norte")
    expect(afterChange.selected?.supplierCode).toEqual("syscom")
  })
})
