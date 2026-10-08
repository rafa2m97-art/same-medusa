import { model } from "@medusajs/framework/utils"
import Package from "./package"

/**
 * Cómo se empaca físicamente UN origen (SupplierWarehouse) de una
 * AllocationSnapshot (plan §5/§6). Un PackagePlan nunca cruza origins —
 * por eso la clave real es (allocation_snapshot_id, supplier_warehouse_id),
 * nunca solo la snapshot: una allocation multi-origen (Etapa 6) produce
 * TANTOS PackagePlan como orígenes tenga, nunca uno que mezcle EXEL-MY
 * con EXEL-MX ni EXEL con SYSCOM.
 *
 * `fingerprint` (plan §43): combina el contenido de la allocation para
 * ese origen + peso/dimensiones reales usados + versión de la política
 * de empaque. Si cualquiera cambia, el plan vigente debe superseder-se y
 * recalcularse — nunca reutilizar un plan viejo sobre datos nuevos.
 *
 * Igual que AllocationSnapshot (Etapa 6): nunca se borra, solo
 * `superseded` -- queda como historial auditable.
 */
const PackagePlan = model.define("package_plan", {
  id: model.id().primaryKey(),
  allocation_snapshot_id: model.text(),
  supplier_id: model.text(),
  supplier_warehouse_id: model.text(),
  status: model.enum(["active", "superseded", "unshippable", "missing_data"]).default("active"),
  fingerprint: model.text(),
  packing_rule_version: model.text(),
  unshippable_reason: model.text().nullable(),
  metadata: model.json().nullable(),
  packages: model.hasMany(() => Package, { mappedBy: "package_plan" }),
}).indexes([
  {
    on: ["allocation_snapshot_id", "supplier_warehouse_id"],
  },
  {
    on: ["status"],
  },
])

export default PackagePlan
