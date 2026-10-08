import { model } from "@medusajs/framework/utils"
import Package from "./package"

/**
 * UNA unidad (o grupo de unidades idénticas) de una Variant dentro de UN
 * Package físico (plan §5/§13/§14). `allocation_assignment_id` conserva
 * la trazabilidad hacia la AllocationAssignment exacta de Etapa 6 de la
 * que proviene esta cantidad — invariante obligatoria (plan §14):
 *
 *   sum(package_item.quantity) por allocation_assignment_id
 *   ==
 *   esa AllocationAssignment.quantity
 *
 * `variant_id`/`allocation_assignment_id` son campos planos (cross-
 * módulo, mismo patrón que todo el resto del proyecto) — este módulo
 * nunca tiene FK real hacia Product ni hacia warehouse-routing.
 */
const PackageItem = model.define("package_planning_package_item", {
  id: model.id().primaryKey(),
  allocation_assignment_id: model.text(),
  variant_id: model.text(),
  quantity: model.number(),
  package: model.belongsTo(() => Package, { mappedBy: "items" }),
})

export default PackageItem
