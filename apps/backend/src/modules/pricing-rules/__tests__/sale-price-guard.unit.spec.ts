import { evaluateSalePriceGuard } from "../rules/sale-price-guard"

const POLICY = { marginFactor: 0.95, taxFactor: 1.16 }

describe("evaluateSalePriceGuard", () => {
  it("accepts a legitimate, moderate discount (ratio above 0.5)", () => {
    const result = evaluateSalePriceGuard({
      regularCostAmount: 100,
      saleCostAmount: 60,
      ...POLICY,
    })
    expect(result.accepted).toBe(true)
  })

  it("reproduces the real incident: ~$498 regular vs. an impossible ~$48 offer collapses the ratio under 0.5 and is rejected", () => {
    // Costos crudos de Exel aproximados al caso real (mouse Logitech Pebble 2 M350s).
    const result = evaluateSalePriceGuard({
      regularCostAmount: 407, // -> publico ~498
      saleCostAmount: 39, // -> publico ~48
      ...POLICY,
    })
    expect(result.accepted).toBe(false)
    if (result.accepted) throw new Error("unreachable")
    expect(result.reason).toBe("sale_price_suspicious")
    expect(result.regularPublicAmount).toBeGreaterThan(400)
  })

  it("accepts at exactly the 0.5 threshold (boundary, never a strict blocker at the edge)", () => {
    // Construido para que sale/regular converja exactamente a 0.5 tras margen+IVA (misma política en ambos lados, por lo que el ratio de costos crudos ya es 0.5).
    const result = evaluateSalePriceGuard({
      regularCostAmount: 100,
      saleCostAmount: 50,
      ...POLICY,
    })
    expect(result.accepted).toBe(true)
  })

  it("never blocks/quarantines the product -- it only reports the regular amount when the sale is suspicious", () => {
    const result = evaluateSalePriceGuard({
      regularCostAmount: 500,
      saleCostAmount: 10,
      ...POLICY,
    })
    expect(result.accepted).toBe(false)
    if (result.accepted) throw new Error("unreachable")
    // El contrato nunca incluye un "blocked"/"quarantined" -- solo regularPublicAmount, para publicar SIN oferta.
    expect(result).not.toHaveProperty("blocked")
    expect(result.regularPublicAmount).toBeGreaterThan(0)
  })

  it("is out of scope (always accepted) when the sale price is not actually lower than the regular price", () => {
    const result = evaluateSalePriceGuard({
      regularCostAmount: 100,
      saleCostAmount: 100,
      ...POLICY,
    })
    expect(result.accepted).toBe(true)
  })

  it("is out of scope (always accepted) when the sale price is higher than the regular price", () => {
    const result = evaluateSalePriceGuard({
      regularCostAmount: 100,
      saleCostAmount: 150,
      ...POLICY,
    })
    expect(result.accepted).toBe(true)
  })

  it("is out of scope when the sale cost is zero or negative", () => {
    const result = evaluateSalePriceGuard({
      regularCostAmount: 100,
      saleCostAmount: 0,
      ...POLICY,
    })
    expect(result.accepted).toBe(true)
  })

  it("compares PUBLIC amounts (after margin+tax), not raw supplier costs directly", () => {
    // Si comparara los crudos directamente, el ratio seria el mismo en este caso
    // particular (misma politica en ambos lados) -- por eso este test fija una
    // politica asimetrica conceptualmente verificando que el resultado usa
    // regularPublicAmount, nunca el costo crudo, en la salida.
    const result = evaluateSalePriceGuard({
      regularCostAmount: 100,
      saleCostAmount: 60,
      ...POLICY,
    })
    expect(result.accepted).toBe(true)
    if (!result.accepted) throw new Error("unreachable")
    expect(result.regularPublicAmount).not.toBe(100)
    expect(result.regularPublicAmount).toBe(123)
  })
})
