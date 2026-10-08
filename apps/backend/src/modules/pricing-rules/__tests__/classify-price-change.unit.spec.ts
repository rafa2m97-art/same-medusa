import { classifyPriceChange } from "../rules/classify-price-change"

const BASE_POLICY = {
  code: "exel-default-v1",
  currencyCode: "mxn",
  marginFactor: 0.95,
  taxFactor: 1.16,
  minChangeRatio: 0.5,
  maxChangeRatio: 2.0,
}

function baseInput() {
  return {
    costAmount: 100,
    policy: BASE_POLICY,
    lastAcceptedAmount: null as number | null,
  }
}

describe("classifyPriceChange — fórmula real de Exel preservada exactamente", () => {
  // 3. fórmula actual Exel produce 100 -> 123.
  it("costo 100 -> precio público 123 (margen 0.95, IVA 1.16, ceil)", () => {
    const result = classifyPriceChange(baseInput())
    expect(result).toMatchObject({ action: "ACCEPT", publicPriceAmount: 123 })
  })

  // 4. fórmula real 382.53 -> 468.
  it("costo 382.53 -> precio público 468 (caso de regresión real)", () => {
    const result = classifyPriceChange({ ...baseInput(), costAmount: 382.53 })
    expect(result).toMatchObject({ action: "ACCEPT", publicPriceAmount: 468 })
  })

  // 25 (Etapa 5). rounding exacto según la regla real (ceil, no round/floor).
  it("redondea hacia ARRIBA (ceil), nunca hacia el más cercano", () => {
    const result = classifyPriceChange(baseInput())
    if (result.action === "ACCEPT") {
      expect(result.publicPriceAmount).toEqual(123)
      expect(result.publicPriceAmount).not.toEqual(Math.round((100 / 0.95) * 1.16))
    } else {
      throw new Error("expected ACCEPT")
    }
  })

  // 24 (Etapa 5). floating point edge cases.
  it("maneja bordes de floating point sin redondear de más ni de menos", () => {
    // 95 / 0.95 * 1.16 = 116.0 exacto en teoría -- candidato real a drift de flotantes.
    const result = classifyPriceChange({ ...baseInput(), costAmount: 95 })
    expect(result).toMatchObject({ action: "ACCEPT", publicPriceAmount: 116 })
  })
})

describe("classifyPriceChange — anomalías día-a-día, banda desde PricingPolicy (21)", () => {
  // 22. cambio dentro de banda -> ACCEPT.
  it("una variación normal (dentro de banda) acepta aunque haya precio previo", () => {
    const result = classifyPriceChange({ ...baseInput(), costAmount: 105, lastAcceptedAmount: 123 })
    expect(result.action).toEqual("ACCEPT")
  })

  // 23. cambio extremo válido -> REVIEW. Ejemplo real del plan: 10,000 -> 500.
  it("caída >50% respecto al último precio aceptado -> REVIEW", () => {
    const result = classifyPriceChange({
      ...baseInput(),
      costAmount: 409, // ~500 publico
      lastAcceptedAmount: 10000,
    })
    expect(result.action).toEqual("REVIEW")
    if (result.action === "REVIEW") {
      expect(result.reason).toEqual("extreme_price_change")
      expect(result.previousAmount).toEqual(10000)
    }
  })

  it("alza extrema (>2x) también activa REVIEW, no solo caídas", () => {
    const result = classifyPriceChange({
      ...baseInput(),
      costAmount: 100, // 123 publico
      lastAcceptedAmount: 50, // 123/50 = 2.46x
    })
    expect(result.action).toEqual("REVIEW")
  })

  // 21. el umbral viene de la policy, no de una constante mágica -- la
  // MISMA variación que arriba disparó REVIEW con banda 0.5x-2.0x deja
  // de dispararla con una banda más permisiva.
  it("una policy con banda más ancha acepta una variación que otra policy marcaría REVIEW", () => {
    const widePolicy = { ...BASE_POLICY, minChangeRatio: 0.01, maxChangeRatio: 100 }
    const result = classifyPriceChange({
      costAmount: 409,
      policy: widePolicy,
      lastAcceptedAmount: 10000,
    })
    expect(result.action).toEqual("ACCEPT")
  })

  // REVIEW nunca expone 'publicPriceAmount' (solo ACCEPT puede producirlo).
  it("REVIEW nunca expone 'publicPriceAmount'", () => {
    const result = classifyPriceChange({ ...baseInput(), costAmount: 409, lastAcceptedAmount: 10000 })
    expect("publicPriceAmount" in result).toEqual(false)
  })

  it("el primer precio (sin previo) siempre ACCEPT, nunca REVIEW", () => {
    const result = classifyPriceChange({ ...baseInput(), costAmount: 1, lastAcceptedAmount: null })
    expect(result.action).toEqual("ACCEPT")
  })
})

describe("classifyPriceChange — versionado de política", () => {
  it("el policyCode de la política usada queda en el resultado ACCEPT", () => {
    const result = classifyPriceChange({
      ...baseInput(),
      policy: { ...BASE_POLICY, code: "exel-default-v2", marginFactor: 0.9 },
    })
    expect(result).toMatchObject({ action: "ACCEPT", policyCode: "exel-default-v2" })
  })

  it("dos políticas distintas producen precios distintos para el mismo costo", () => {
    const v1 = classifyPriceChange(baseInput())
    const v2 = classifyPriceChange({
      ...baseInput(),
      policy: { ...BASE_POLICY, code: "exel-default-v2", marginFactor: 0.9 },
    })
    expect(v1.action).toEqual("ACCEPT")
    expect(v2.action).toEqual("ACCEPT")
    if (v1.action === "ACCEPT" && v2.action === "ACCEPT") {
      expect(v1.publicPriceAmount).not.toEqual(v2.publicPriceAmount)
    }
  })

  it("y el policyCode de la REVIEW también queda asociado a la policy usada", () => {
    const result = classifyPriceChange({
      costAmount: 409,
      policy: { ...BASE_POLICY, code: "exel-default-v3" },
      lastAcceptedAmount: 10000,
    })
    expect(result).toMatchObject({ action: "REVIEW", policyCode: "exel-default-v3" })
  })
})
