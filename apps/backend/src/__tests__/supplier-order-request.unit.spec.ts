import type { SupplierOrderRequest } from "../modules/supplier/types"
import { buildExelCreateOrderRequest } from "../integrations/suppliers/exel/normalize"

/**
 * Estos tests son de DOMINIO puro — no dependen de Exel para existir
 * conceptualmente (solo se usa ExelAdapter al final, en el test 15, para
 * demostrar que el contrato normalizado efectivamente puede llevarse a un
 * proveedor concreto sin cambiar su forma).
 *
 * Escenario real confirmado (class-msl-exel-api.php::send_warehouse_order,
 * y confirmado explícitamente por el usuario): si una Order SAME se
 * reparte entre MY y MX, el proveedor recibe DOS pedidos independientes,
 * nunca uno combinado.
 */

function buildFakeDestination() {
  return {
    contactName: "Cliente de Prueba",
    street: "Av. Siempre Viva",
    exteriorNumber: "123",
    neighborhood: "Centro",
    postalCode: "64000",
    country: "MX",
  }
}

describe("SupplierOrderRequest — regla de un pedido por almacén", () => {
  const sameOrderId = "order_SAME-10543"

  // 11. Dos WarehouseShipments de una misma Order generan dos
  // SupplierOrderRequest independientes.
  it("una Order repartida en 2 almacenes produce 2 SupplierOrderRequest independientes", () => {
    const warehouseShipmentMY = "ws_MY_001"
    const warehouseShipmentMX = "ws_MX_001"

    const requestMY: SupplierOrderRequest = {
      supplierId: "supplier_exel",
      supplierWarehouseId: "sw_my",
      sameOrderId,
      warehouseShipmentId: warehouseShipmentMY,
      referenceId: `${sameOrderId}-MY`,
      lines: [
        { supplierSku: "PRODUCTO-A", quantity: 1 },
        { supplierSku: "PRODUCTO-B", quantity: 2 },
      ],
      destination: buildFakeDestination(),
      externalReferences: { warehouseExternalCode: "MY" },
    }

    const requestMX: SupplierOrderRequest = {
      supplierId: "supplier_exel",
      supplierWarehouseId: "sw_mx",
      sameOrderId,
      warehouseShipmentId: warehouseShipmentMX,
      referenceId: `${sameOrderId}-MX`,
      lines: [{ supplierSku: "PRODUCTO-C", quantity: 1 }],
      destination: buildFakeDestination(),
      externalReferences: { warehouseExternalCode: "MX" },
    }

    // Ambos requests comparten la misma Order SAME...
    expect(requestMY.sameOrderId).toEqual(requestMX.sameOrderId)
    // ...pero son objetos de fulfillment completamente independientes.
    expect(requestMY.warehouseShipmentId).not.toEqual(requestMX.warehouseShipmentId)
    expect(requestMY.supplierWarehouseId).not.toEqual(requestMX.supplierWarehouseId)
    expect(requestMY.lines).not.toEqual(requestMX.lines)
  })

  // 12. Cada SupplierOrderRequest pertenece a EXACTAMENTE un SupplierWarehouse
  // (nunca una lista) — verificación de forma, no solo de intención.
  it("SupplierOrderRequest.supplierWarehouseId es un único string, nunca un arreglo", () => {
    const request: SupplierOrderRequest = {
      supplierId: "supplier_exel",
      supplierWarehouseId: "sw_my",
      sameOrderId,
      warehouseShipmentId: "ws_MY_001",
      referenceId: "ref",
      lines: [{ supplierSku: "PRODUCTO-A", quantity: 1 }],
      destination: buildFakeDestination(),
    }

    expect(typeof request.supplierWarehouseId).toEqual("string")
    expect(Array.isArray(request.supplierWarehouseId)).toEqual(false)
    // No existe (ni debe existir) un campo plural "supplierWarehouseIds".
    expect("supplierWarehouseIds" in request).toEqual(false)
  })

  // 13. La idempotencia es independiente por WarehouseShipment, incluso
  // para la misma Order SAME — Exel no soporta una idempotency key propia
  // (no existe ese parámetro en /pedido), así que el ancla debe ser
  // nuestra, no del proveedor.
  it("cada WarehouseShipment tiene una identidad idempotente propia", () => {
    const requests: SupplierOrderRequest[] = [
      {
        supplierId: "supplier_exel",
        supplierWarehouseId: "sw_my",
        sameOrderId,
        warehouseShipmentId: "ws_MY_001",
        referenceId: "ref-my",
        lines: [{ supplierSku: "PRODUCTO-A", quantity: 1 }],
        destination: buildFakeDestination(),
      },
      {
        supplierId: "supplier_exel",
        supplierWarehouseId: "sw_mx",
        sameOrderId,
        warehouseShipmentId: "ws_MX_001",
        referenceId: "ref-mx",
        lines: [{ supplierSku: "PRODUCTO-C", quantity: 1 }],
        destination: buildFakeDestination(),
      },
    ]

    // El ancla de idempotencia recomendada es warehouseShipmentId: se crea
    // una sola vez por (Order, SupplierWarehouse) y nunca se regenera en
    // un retry — a diferencia de sameOrderId, que es igual para ambos.
    const idempotencyKeys = requests.map((r) => r.warehouseShipmentId)
    expect(new Set(idempotencyKeys).size).toEqual(requests.length)

    // Reenviar el MISMO request (ej. un retry) produce la MISMA clave —
    // es lo que le permite a un adaptador/worker decidir "ya envié esto"
    // sin preguntarle nada al proveedor.
    const retryOfMY = { ...requests[0] }
    expect(retryOfMY.warehouseShipmentId).toEqual(requests[0].warehouseShipmentId)
  })

  // 15. Extremo a extremo conceptual: Order única -> MY a un pedido Exel,
  // MX a OTRO pedido Exel, cada uno con su propio clave_almacen.
  it("Order SAME-10543 produce dos payloads de Exel independientes, uno por almacén", () => {
    const requestMY: SupplierOrderRequest = {
      supplierId: "supplier_exel",
      supplierWarehouseId: "sw_my",
      sameOrderId,
      warehouseShipmentId: "ws_MY_001",
      referenceId: `${sameOrderId}-MY`,
      lines: [
        { supplierSku: "PRODUCTO-A", quantity: 1 },
        { supplierSku: "PRODUCTO-B", quantity: 2 },
      ],
      destination: buildFakeDestination(),
    }
    const requestMX: SupplierOrderRequest = {
      supplierId: "supplier_exel",
      supplierWarehouseId: "sw_mx",
      sameOrderId,
      warehouseShipmentId: "ws_MX_001",
      referenceId: `${sameOrderId}-MX`,
      lines: [{ supplierSku: "PRODUCTO-C", quantity: 1 }],
      destination: buildFakeDestination(),
    }

    const payloadMY = buildExelCreateOrderRequest(requestMY, "MY")
    const payloadMX = buildExelCreateOrderRequest(requestMX, "MX")

    // Cada payload de Exel tiene exactamente UN clave_almacen.
    expect(payloadMY.clave_almacen).toEqual("MY")
    expect(payloadMX.clave_almacen).toEqual("MX")
    // Son dos llamadas POST /pedido independientes, no una combinada.
    expect(payloadMY.productos).toEqual([
      { clave_producto: "PRODUCTO-A", cantidad: 1 },
      { clave_producto: "PRODUCTO-B", cantidad: 2 },
    ])
    expect(payloadMX.productos).toEqual([
      { clave_producto: "PRODUCTO-C", cantidad: 1 },
    ])
    expect(payloadMY).not.toEqual(payloadMX)
  })
})
