import { model } from "@medusajs/framework/utils"
import Supplier from "./supplier"
import SyncConflict from "./sync-conflict"

/**
 * Una ejecución completa de sincronización/reconciliación contra UN
 * proveedor. Nunca escribe inventario real en Etapa 3 (eso es Etapa 4) —
 * `mode` existe desde ahora porque el modelo debe ser compatible con esa
 * etapa sin migrar de nuevo, pero esta etapa solo necesita operar
 * correctamente en "capture_only"/"dry_run".
 *
 * Identidad/idempotencia (plan §12): Exel NO manda un batch id — el run_id
 * real de producción hoy es solo timestamp+pid (ver logs reales
 * conflict_draft_MSL-<timestamp>-<pid>.log), sin protección real contra
 * reproceso de la misma captura. Aquí se diseña algo mejor sin asumir nada
 * que Exel no provee: `source_snapshot_checksum` (hash del snapshot crudo
 * ya normalizado/paginado, nunca el payload completo) + `supplier_id` dan
 * una identidad real verificable. unique(supplier_id, source_snapshot_checksum)
 * cuando el checksum existe detecta "esta captura exacta ya se procesó para
 * este proveedor" a nivel de base de datos, sin lógica distribuida — ver
 * reconciliation/sync-run-idempotency.ts.
 *
 * Métricas (plan §15): total_rows/applied_count/quarantined_count/
 * skipped_count/error_count son columnas, no algo que haya que calcular
 * recorriendo SyncConflict en cada consulta de reporte.
 */
const SyncRun = model.define("sync_run", {
  id: model.id().primaryKey(),
  mode: model.enum(["capture_only", "dry_run", "apply"]).default("dry_run"),
  status: model
    .enum([
      "pending",
      "running",
      "completed",
      "completed_with_conflicts",
      "failed",
      "cancelled",
    ])
    .default("pending"),
  started_at: model.dateTime().nullable(),
  completed_at: model.dateTime().nullable(),
  total_rows: model.number().default(0),
  applied_count: model.number().default(0),
  quarantined_count: model.number().default(0),
  skipped_count: model.number().default(0),
  error_count: model.number().default(0),
  source_snapshot_ref: model.text().nullable(),
  source_snapshot_checksum: model.text().nullable(),
  correlation_id: model.text().nullable(),
  failure_reason: model.text().nullable(),
  metadata: model.json().nullable(),
  supplier: model.belongsTo(() => Supplier, { mappedBy: "sync_runs" }),
  conflicts: model.hasMany(() => SyncConflict, { mappedBy: "sync_run" }),
}).indexes([
  {
    on: ["supplier_id", "source_snapshot_checksum"],
    unique: true,
    where: { source_snapshot_checksum: { $ne: null } },
  },
  {
    on: ["supplier_id", "started_at"],
  },
])

export default SyncRun
