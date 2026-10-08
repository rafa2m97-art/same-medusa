import { model } from "@medusajs/framework/utils"
import PackagePlan from "./package-plan"
import PackageItem from "./package-item"

/**
 * UN paquete físico real dentro de un PackagePlan (plan §5/§11). Unidades
 * canónicas internas: **kg** y **cm** — iguales a las que ya usa
 * WooCommerce/Envia en producción hoy (`weightUnit: "KG"`,
 * `lengthUnit: "CM"`, confirmado por SSH en
 * `class-same-dynamic-shipping.php::build_envia_api_payload`) y al
 * mismo tipo de dato (`model.float()`, sin unidad propia) que ya usa
 * `ProductVariant.weight/length/width/height` nativo de Medusa — elegir
 * otra unidad interna (ej. gramos/mm) no habría ganado precisión real
 * (el campo nativo ya es float) y sí habría forzado una conversión
 * extra sin necesidad en cada lectura/escritura.
 *
 * Fila propia, nunca JSON embebido (plan §5: "no quiero guardar todo
 * únicamente en JSON si necesitamos auditoría/queries") — se puede
 * preguntar "¿cuántos paquetes tiene este plan?" o "¿qué paquetes
 * exceden X kg?" con un filtro plano.
 */
const Package = model.define("package_planning_package", {
  id: model.id().primaryKey(),
  sequence_number: model.number(),
  weight_kg: model.float(),
  length_cm: model.float(),
  width_cm: model.float(),
  height_cm: model.float(),
  status: model.enum(["planned", "unshippable"]).default("planned"),
  unshippable_reason: model.text().nullable(),
  metadata: model.json().nullable(),
  package_plan: model.belongsTo(() => PackagePlan, { mappedBy: "packages" }),
  items: model.hasMany(() => PackageItem, { mappedBy: "package" }),
})

export default Package
