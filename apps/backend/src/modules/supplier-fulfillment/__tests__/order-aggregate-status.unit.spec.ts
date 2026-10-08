import { deriveOrderFulfillmentStatus } from "../rules/order-aggregate-status"

describe("deriveOrderFulfillmentStatus", () => {
  it("PREPARING cuando todo está pendiente", () => {
    expect(deriveOrderFulfillmentStatus(["PENDING", "PENDING"])).toBe("PREPARING")
  })

  it("PREPARING incluso si algunas guías ya están listas pero otras no (plan §29, ejemplo real)", () => {
    expect(deriveOrderFulfillmentStatus(["LABEL_PURCHASED", "READY_FOR_LABEL"])).toBe("PREPARING")
  })

  it("PROCESSING cuando todos los orígenes están aceptados/procesando", () => {
    expect(deriveOrderFulfillmentStatus(["SUPPLIER_ACCEPTED", "PROCESSING"])).toBe("PROCESSING")
  })

  it("PARTIALLY_SHIPPED cuando algunos están enviados y otros no", () => {
    expect(deriveOrderFulfillmentStatus(["SHIPPED", "PROCESSING"])).toBe("PARTIALLY_SHIPPED")
  })

  it("SHIPPED cuando todos los orígenes están enviados o entregados", () => {
    expect(deriveOrderFulfillmentStatus(["SHIPPED", "SHIPPED"])).toBe("SHIPPED")
    expect(deriveOrderFulfillmentStatus(["SHIPPED", "DELIVERED"])).toBe("SHIPPED")
  })

  it("DELIVERED solo cuando TODOS los orígenes están entregados", () => {
    expect(deriveOrderFulfillmentStatus(["DELIVERED", "DELIVERED"])).toBe("DELIVERED")
  })

  it("REQUIRES_ATTENTION domina sobre cualquier otro estado, sin importar qué tan avanzados estén los demás orígenes", () => {
    expect(deriveOrderFulfillmentStatus(["DELIVERED", "REQUIRES_MANUAL_REVIEW"])).toBe("REQUIRES_ATTENTION")
    expect(deriveOrderFulfillmentStatus(["PENDING", "REQUIRES_MANUAL_REVIEW"])).toBe("REQUIRES_ATTENTION")
  })

  it("CANCELLED solo cuando TODOS los orígenes están cancelados", () => {
    expect(deriveOrderFulfillmentStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED")
  })

  it("ignora orígenes cancelados al evaluar el resto (un origen cancelado no cuenta como 'pendiente')", () => {
    expect(deriveOrderFulfillmentStatus(["CANCELLED", "DELIVERED"])).toBe("DELIVERED")
  })

  it("PREPARING para un arreglo vacío (ningún shipment creado todavía)", () => {
    expect(deriveOrderFulfillmentStatus([])).toBe("PREPARING")
  })
})
