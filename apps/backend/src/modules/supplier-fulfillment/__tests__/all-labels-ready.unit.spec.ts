import { allLabelsReady } from "../rules/all-labels-ready"

describe("allLabelsReady", () => {
  it("es false cuando cualquier origen aún no tiene guía (plan §20, confirmado real)", () => {
    expect(allLabelsReady(["LABEL_PURCHASED", "READY_FOR_LABEL"])).toBe(false)
  })

  it("es true solo cuando TODOS los orígenes relevantes ya tienen guía o están más adelante", () => {
    expect(allLabelsReady(["LABEL_PURCHASED", "SUPPLIER_SUBMISSION_PENDING"])).toBe(true)
  })

  it("es false mientras cualquier origen esté fallando la compra de guía", () => {
    expect(allLabelsReady(["LABEL_PURCHASED", "LABEL_FAILED_RETRYABLE"])).toBe(false)
  })

  it("ignora orígenes cancelados -- no deben bloquear indefinidamente a los demás", () => {
    expect(allLabelsReady(["LABEL_PURCHASED", "CANCELLED"])).toBe(true)
  })

  it("es false para un arreglo vacío (nada que declarar listo)", () => {
    expect(allLabelsReady([])).toBe(false)
  })

  it("es false si TODOS están cancelados (nada relevante queda)", () => {
    expect(allLabelsReady(["CANCELLED", "CANCELLED"])).toBe(false)
  })
})
