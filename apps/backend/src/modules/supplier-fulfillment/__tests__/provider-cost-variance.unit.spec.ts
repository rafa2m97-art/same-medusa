import { evaluateProviderCostVariance, type ProviderCostVariancePolicy } from "../rules/provider-cost-variance"

const POLICY: ProviderCostVariancePolicy = { maxAcceptableVarianceRatio: 0.2, rejectVarianceRatio: 1.0 }

describe("evaluateProviderCostVariance", () => {
  it("ACCEPT cuando el costo real coincide con lo cotizado", () => {
    expect(evaluateProviderCostVariance(180, 180, POLICY)).toBe("ACCEPT")
  })

  it("ACCEPT dentro de la tolerancia (180 cotizado, 184 real -- ejemplo del usuario)", () => {
    expect(evaluateProviderCostVariance(180, 184, POLICY)).toBe("ACCEPT")
  })

  it("REVIEW cuando la variación excede la tolerancia pero no el umbral de rechazo", () => {
    expect(evaluateProviderCostVariance(180, 230, POLICY)).toBe("REVIEW")
  })

  it("REJECT cuando el costo real es dramáticamente distinto (180 cotizado, 400 real -- ejemplo del usuario)", () => {
    expect(evaluateProviderCostVariance(180, 400, POLICY)).toBe("REJECT")
  })

  it("ACCEPT sin cotización contra qué comparar -- nunca bloquea una compra real ya hecha", () => {
    expect(evaluateProviderCostVariance(null, 999, POLICY)).toBe("ACCEPT")
  })

  it("detecta variación también cuando el costo real es MENOR al cotizado", () => {
    expect(evaluateProviderCostVariance(180, 50, POLICY)).toBe("REVIEW")
  })
})
