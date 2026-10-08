/**
 * Formato de métricas de salida de un SyncRun — pedido explícito del
 * usuario, Etapa 3 §15. Todavía no hay dashboard; esto solo demuestra que
 * el modelo/servicio puede producir el resumen legible sin tener que
 * volver a consultar SyncConflict fila por fila.
 */
export interface SyncRunMetricsInput {
  supplierCode: string
  runId: string
  totalRows: number
  appliedCount: number
  quarantinedCount: number
  skippedCount: number
  errorCount: number
  startedAt: Date
  completedAt: Date
}

export function formatSyncRunMetrics(input: SyncRunMetricsInput): string {
  const durationMs = input.completedAt.getTime() - input.startedAt.getTime()
  return [
    `Supplier: ${input.supplierCode}`,
    `Run: ${input.runId}`,
    `Rows: ${input.totalRows.toLocaleString("en-US")}`,
    ``,
    `APPLY: ${input.appliedCount.toLocaleString("en-US")}`,
    `QUARANTINE: ${input.quarantinedCount.toLocaleString("en-US")}`,
    `SKIPPED: ${input.skippedCount.toLocaleString("en-US")}`,
    `ERRORS: ${input.errorCount.toLocaleString("en-US")}`,
    ``,
    `Duration: ${(durationMs / 1000).toFixed(1)}s`,
  ].join("\n")
}
