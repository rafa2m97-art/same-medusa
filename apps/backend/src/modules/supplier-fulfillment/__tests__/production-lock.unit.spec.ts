import { isRealLabelPurchaseAllowed } from "../rules/production-lock"

describe("isRealLabelPurchaseAllowed", () => {
  it("es false por defecto (nada configurado)", () => {
    expect(
      isRealLabelPurchaseAllowed({ enviaEnvironment: undefined, labelPurchaseEnabledFlag: undefined, productionUnlockedFlag: undefined })
    ).toBe(false)
  })

  it("es false si falta CUALQUIERA de las tres condiciones", () => {
    expect(
      isRealLabelPurchaseAllowed({
        enviaEnvironment: "production",
        labelPurchaseEnabledFlag: "true",
        productionUnlockedFlag: "false",
      })
    ).toBe(false)
    expect(
      isRealLabelPurchaseAllowed({
        enviaEnvironment: "production",
        labelPurchaseEnabledFlag: "false",
        productionUnlockedFlag: "true",
      })
    ).toBe(false)
    expect(
      isRealLabelPurchaseAllowed({
        enviaEnvironment: "sandbox",
        labelPurchaseEnabledFlag: "true",
        productionUnlockedFlag: "true",
      })
    ).toBe(false)
  })

  it("es true únicamente cuando las TRES condiciones son verdaderas a la vez", () => {
    expect(
      isRealLabelPurchaseAllowed({
        enviaEnvironment: "production",
        labelPurchaseEnabledFlag: "true",
        productionUnlockedFlag: "true",
      })
    ).toBe(true)
  })

  it("no se activa con valores 'truthy' que no sean el string exacto 'true' (ej. '1', 'yes')", () => {
    expect(
      isRealLabelPurchaseAllowed({
        enviaEnvironment: "production",
        labelPurchaseEnabledFlag: "1",
        productionUnlockedFlag: "yes",
      })
    ).toBe(false)
  })
})
