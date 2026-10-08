import { model } from "@medusajs/framework/utils"
import AllocationSnapshot from "./allocation-snapshot"
import AllocationAssignment from "./allocation-assignment"

/**
 * Una línea del carrito (una Variant + cantidad pedida) dentro de un
 * AllocationSnapshot. `variant_id` es un campo plano (cross-módulo,
 * mismo patrón que `SupplierProductMapping.variant_id`) — este módulo
 * nunca tiene FK real hacia Product.
 *
 * Asume que el carrito ya llega con UNA línea por Variant (sin
 * duplicados) — es responsabilidad del workflow que construye el input
 * (no de este modelo ni del algoritmo puro) fusionar líneas repetidas
 * antes de llegar aquí.
 */
const AllocationLine = model.define("allocation_line", {
  id: model.id().primaryKey(),
  variant_id: model.text(),
  requested_quantity: model.number(),
  allocation_snapshot: model.belongsTo(() => AllocationSnapshot, {
    mappedBy: "lines",
  }),
  assignments: model.hasMany(() => AllocationAssignment, {
    mappedBy: "allocation_line",
  }),
})

export default AllocationLine
