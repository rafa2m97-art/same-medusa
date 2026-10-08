import { model } from "@medusajs/framework/utils"
import SupplierProductMapping from "./supplier-product-mapping"

/**
 * Estado OPERACIONAL de confianza sobre los datos que un proveedor manda
 * para un SupplierProductMapping — separado de la identidad (ver decisión
 * Etapa 3 punto 2 en supplier-product-mapping.ts). Responde: "¿podemos
 * confiar HOY en los datos que este proveedor manda para este producto?"
 *
 * 1:1 real con SupplierProductMapping (unique en supplier_product_mapping_id)
 * — se crea la primera vez que ese mapping pasa por una reconciliación, no
 * al mismo tiempo que el mapping (un mapping puede existir sin haber sido
 * reconciliado todavía).
 *
 * Campos, justificados contra uso real en inventory_reconciler.py/
 * conflict_draft.php (no copiados a ciegas del borrador del plan):
 *   - status/reason/quarantined_since: el estado visible y su razón vigente.
 *   - last_evaluated_at: necesario para saber si un mapping fue tocado en el
 *     SyncRun más reciente (un producto que deja de aparecer en el feed del
 *     proveedor no actualiza esto — eso es una señal en sí misma).
 *   - consecutive_consistent_runs: el contador real de salida de cuarentena
 *     (ver reconciliation/classify-conflicts.ts) — generaliza el chequeo
 *     real de producción (que compara exactamente los últimos 2 runs en
 *     conflict_draft.php) a un contador persistente con umbral 2.
 *   - last_supplier_total/last_warehouse_total: los últimos valores vistos
 *     de las dos fuentes que pueden contradecirse (catálogo vs. desglose);
 *     sin esto, depurar por qué algo sigue en cuarentena requiere ir a
 *     buscar el SyncConflict más reciente — se cachean aquí para lectura
 *     rápida (dashboards/soporte), el SyncConflict sigue siendo la fuente
 *     de verdad detallada.
 *   - last_conflict_at/last_apply_at: visibilidad operacional de cuándo fue
 *     la última vez que algo salió mal vs. la última vez que se confirmó —
 *     sin esto no se puede distinguir "nunca se ha confirmado" de "se
 *     confirmó hace mucho y dejó de intentarse".
 *
 * Agregado Etapa 4 (Inventory) — NO se creó un modelo nuevo
 * "InventoryApplyRecord" (plan §11): el único dato que Inventory necesita
 * en el camino caliente es "¿cuál fue el último SyncRun cuyo resultado ya
 * está reflejado en InventoryLevel?", para la protección contra stale
 * writes (ver reconciliation/inventory-apply-plan.ts). Eso es una lectura
 * O(1) por mapping — agregar 2 campos aquí evita un join/tabla nueva solo
 * para esa comparación. La trazabilidad completa (qué cambió, antes/
 * después, por almacén) vive en eventos de commerce-audit
 * (INVENTORY_LEVEL_CHANGED), no aquí — este modelo solo cachea el
 * resultado de la comparación, nunca el historial completo.
 *   - last_applied_sync_run_id: qué SyncRun produjo el InventoryLevel
 *     actual (trazabilidad mínima: "este stock vino del run X").
 *   - last_applied_sync_run_started_at: el ancla de orden real para decidir
 *     "¿este nuevo resultado es más viejo que lo que ya aplicamos?" — se
 *     compara `started_at` contra `started_at`, nunca contra la hora en la
 *     que Inventory termina de escribir (que puede ser desordenada si dos
 *     SyncRuns corren en paralelo y terminan en otro orden).
 */
const SupplierProductState = model.define("supplier_product_state", {
  id: model.id().primaryKey(),
  status: model.enum(["active", "quarantined"]).default("active"),
  reason: model.text().nullable(),
  quarantined_since: model.dateTime().nullable(),
  last_evaluated_at: model.dateTime().nullable(),
  consecutive_consistent_runs: model.number().default(0),
  last_supplier_total: model.number().nullable(),
  last_warehouse_total: model.number().nullable(),
  last_conflict_at: model.dateTime().nullable(),
  last_apply_at: model.dateTime().nullable(),
  last_applied_sync_run_id: model.text().nullable(),
  last_applied_sync_run_started_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
  supplier_product_mapping: model.belongsTo(() => SupplierProductMapping, {
    mappedBy: "state",
  }),
}).indexes([
  {
    on: ["supplier_product_mapping_id"],
    unique: true,
  },
])

export default SupplierProductState
