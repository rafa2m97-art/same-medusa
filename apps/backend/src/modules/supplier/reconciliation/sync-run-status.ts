/**
 * Distingue "el sync técnicamente falló" de "el sync terminó bien pero
 * encontró conflictos de negocio" — pedido explícito del usuario, Etapa 3
 * §13. Es información que la UI/alertas necesitan tratar MUY distinto: un
 * `failed` dispara una alerta de infraestructura; un
 * `completed_with_conflicts` es un día normal de operación con proveedores
 * reales.
 */
export type SyncRunCounts = {
  totalRows: number
  appliedCount: number
  quarantinedCount: number
  skippedCount: number
  errorCount: number
}

export type SyncRunFinalStatus =
  | "completed"
  | "completed_with_conflicts"
  | "failed"

export function deriveSyncRunFinalStatus(counts: SyncRunCounts): SyncRunFinalStatus {
  // Fallo técnico total: nada se pudo clasificar en absoluto.
  if (counts.totalRows > 0 && counts.errorCount === counts.totalRows) {
    return "failed"
  }
  if (counts.quarantinedCount > 0 || counts.errorCount > 0) {
    return "completed_with_conflicts"
  }
  return "completed"
}
