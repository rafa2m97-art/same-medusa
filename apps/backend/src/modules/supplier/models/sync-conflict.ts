import { model } from "@medusajs/framework/utils"
import SyncRun from "./sync-run"
import SupplierProductMapping from "./supplier-product-mapping"

/**
 * Un conflicto encontrado durante UN SyncRun. `supplier_product_mapping` es
 * NULLABLE a propósito: UNKNOWN_PRODUCT_MAPPING/AMBIGUOUS_MAPPING ocurren
 * precisamente cuando no hay (o hay más de un) mapping al que amarrar el
 * conflicto — por eso `supplier_sku`/`supplier_reference` se guardan aquí
 * también como campos planos, nunca solo como FK.
 *
 * `conflict_type` es la taxonomía estable (ver reconciliation/taxonomy.ts)
 * para poder filtrar/reportar; `reason` es el detalle humano de ESTE caso.
 *
 * Snapshot crudo (plan §10): NUNCA se guarda el payload completo de Exel
 * aquí. `source_ref` es solo una referencia/ruta al snapshot normalizado
 * que generó este SyncRun (gobernado por el propio SyncRun, no por cada
 * conflicto); lo que SÍ se guarda inline son los números ya agregados
 * (supplier_total/warehouse_total/warehouse_breakdown — un objeto pequeño
 * de a lo más 4-5 claves, nunca una lista de filas crudas).
 */
const SyncConflict = model.define("sync_conflict", {
  id: model.id().primaryKey(),
  supplier_sku: model.text(),
  conflict_type: model.text(),
  reason: model.text(),
  supplier_total: model.number().nullable(),
  warehouse_total: model.number().nullable(),
  warehouse_breakdown: model.json().nullable(),
  source_ref: model.text().nullable(),
  detected_at: model.dateTime(),
  resolved_at: model.dateTime().nullable(),
  resolution: model.text().nullable(),
  metadata: model.json().nullable(),
  sync_run: model.belongsTo(() => SyncRun, { mappedBy: "conflicts" }),
  supplier_product_mapping: model
    .belongsTo(() => SupplierProductMapping, { mappedBy: "conflicts" })
    .nullable(),
}).indexes([
  {
    on: ["sync_run_id", "conflict_type"],
  },
  {
    on: ["supplier_product_mapping_id"],
  },
])

export default SyncConflict
