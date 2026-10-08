/**
 * Decisión PURA de si un ReconciliationResult debe escribirse en el
 * inventario nativo de Medusa, y con qué niveles exactamente — separada de
 * cualquier I/O (DB, workflows) para poder probarla sin levantar nada.
 *
 * Esto es la bisagra entre Reconciliation (decide "¿confío en el dato?") e
 * Inventory (decide "¿cómo lo reflejo?") — Inventory NUNCA vuelve a
 * evaluar confiabilidad de datos de proveedor aquí; solo aplica reglas
 * propias de escritura segura (staleness, mapping/warehouse inactivos).
 */

export interface InventoryApplyPlanInput {
  action: "APPLY" | "QUARANTINE"
  mappingStatus: "active" | "inactive"
  /**
   * Estado de confianza VIGENTE del mapping (SupplierProductState.status),
   * leído DESPUÉS de que Reconciliation ya haya procesado y persistido el
   * resultado de este mismo run (ver nextQuarantineState en
   * quarantine-state.ts). Esto es lo que hace que el ejemplo real del
   * usuario funcione sin lógica adicional aquí: un run individual
   * clasificado APPLY mientras el mapping SIGUE quarantined (todavía no
   * acumuló las 2 reconciliaciones consecutivas consistentes) NO debe
   * tocar Inventory — solo cuando el estado ya transicionó a "active" se
   * confía lo suficiente para escribir. `null` = nunca se ha evaluado
   * (sin SupplierProductState todavía) -> se trata como "active" (nada
   * que desconfiar aún).
   */
  supplierProductStateStatus: "active" | "quarantined" | null
  /** `started_at` del SyncRun que produjo este resultado — ancla de orden, no de reloj de pared del momento en que se aplica. */
  incomingSyncRunStartedAt: Date
  /** `started_at` del SyncRun cuyo resultado está reflejado ACTUALMENTE en Inventory, si alguno. */
  lastAppliedSyncRunStartedAt: Date | null
  normalizedWarehouseLevels: Array<{
    supplierWarehouseId: string
    quantity: number
    warehouseStatus: "active" | "inactive"
  }>
}

export type InventoryApplySkipReason =
  | "not_apply"
  | "inactive_mapping"
  | "still_quarantined"
  | "stale_sync_run"
  | "no_active_warehouses"

export type InventoryApplyPlan =
  | {
      proceed: true
      levelsToApply: Array<{ supplierWarehouseId: string; quantity: number }>
    }
  | { proceed: false; reason: InventoryApplySkipReason }

export function planInventoryApply(input: InventoryApplyPlanInput): InventoryApplyPlan {
  // Principio de Etapa 4: nunca volver a preguntar "¿son confiables estos
  // datos?" — esa pregunta ya la respondió Reconciliation. Un QUARANTINE
  // nunca llega más allá de aquí.
  if (input.action !== "APPLY") {
    return { proceed: false, reason: "not_apply" }
  }

  // §19 — un mapping desactivado no debe seguir recibiendo actualizaciones
  // de este proveedor, aunque el SyncRun haya clasificado APPLY.
  if (input.mappingStatus === "inactive") {
    return { proceed: false, reason: "inactive_mapping" }
  }

  // §8-§9 — "Last Known Good": mientras el mapping SIGA quarantined (no ha
  // acumulado las 2 reconciliaciones consecutivas consistentes todavía),
  // ningún resultado individual APPLY debe tocar Inventory, aunque ESTE
  // run en particular haya sido consistente. Evita que una sola lectura
  // "buena" en medio de inestabilidad real actualice stock prematuramente
  // — la misma razón por la que existe el contador de 2 en primer lugar.
  if (input.supplierProductStateStatus === "quarantined") {
    return { proceed: false, reason: "still_quarantined" }
  }

  // §13 — protección contra stale writes: un SyncRun que EMPEZÓ antes que
  // el último aplicado nunca puede sobreescribirlo, sin importar cuál
  // terminó después. Igual (no solo "antes") también se considera stale:
  // un re-apply del mismo run ya aplicado no debe repetirse.
  if (
    input.lastAppliedSyncRunStartedAt &&
    input.incomingSyncRunStartedAt <= input.lastAppliedSyncRunStartedAt
  ) {
    return { proceed: false, reason: "stale_sync_run" }
  }

  // §18 — un SupplierWarehouse inactivo se EXCLUYE de la escritura (no se
  // borra su StockLocation, simplemente deja de recibir actualizaciones).
  const levelsToApply = input.normalizedWarehouseLevels
    .filter((level) => level.warehouseStatus === "active")
    .map((level) => ({
      supplierWarehouseId: level.supplierWarehouseId,
      quantity: level.quantity,
    }))

  if (levelsToApply.length === 0) {
    return { proceed: false, reason: "no_active_warehouses" }
  }

  return { proceed: true, levelsToApply }
}
