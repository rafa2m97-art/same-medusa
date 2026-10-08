import { model } from "@medusajs/framework/utils"
import AllocationLine from "./allocation-line"

/**
 * UNA porción de una AllocationLine servida por UN (supplier,
 * supplier_warehouse) concreto. Una línea sin split tiene exactamente 1
 * Assignment; una línea dividida entre 2+ almacenes (confirmado real,
 * `same_get_cart_fulfillment_allocations()`) tiene 2+.
 *
 * Fila propia (no JSON embebido en AllocationLine) a propósito — pedido
 * explícito del usuario (plan de Etapa 6, §16): "no meter todo en JSON
 * si necesitamos consultas/auditoría reales", ej. "¿qué se asignó hoy al
 * almacén MY de Exel?" es un filtro plano por supplier_warehouse_id, no
 * un recorrido de JSON.
 *
 * `stock_location_id` se cachea aquí (adicional a supplier_warehouse_id)
 * porque es el identificador que el resto de Medusa nativo
 * (Inventory/Fulfillment) realmente necesita para actuar — evita un
 * join extra en el camino caliente de checkout/fulfillment.
 */
const AllocationAssignment = model.define("allocation_assignment", {
  id: model.id().primaryKey(),
  supplier_id: model.text(),
  supplier_warehouse_id: model.text(),
  stock_location_id: model.text(),
  quantity: model.number(),
  allocation_line: model.belongsTo(() => AllocationLine, {
    mappedBy: "assignments",
  }),
})

export default AllocationAssignment
