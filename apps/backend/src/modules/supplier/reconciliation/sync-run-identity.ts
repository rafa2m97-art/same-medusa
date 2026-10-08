import { createHash } from "node:crypto"

/**
 * Identidad de un SyncRun (plan §12). Exel no manda batch id — el run_id
 * real hoy en producción es solo timestamp+pid (ver logs reales
 * conflict_draft_MSL-<timestamp>-<pid>.log), sin protección real contra
 * reprocesar la misma captura dos veces. No se asume nada que Exel no
 * provee; en vez de eso, el checksum se calcula del lado de SAME, sobre el
 * snapshot YA NORMALIZADO (nunca el payload crudo completo — eso rompería
 * la regla de "nunca guardar payloads gigantes").
 *
 * Esto es lo que hace que la unique index real
 * (supplier_id, source_snapshot_checksum) en SyncRun pueda detectar un
 * rerun accidental de la MISMA captura a nivel de base de datos.
 */
export function computeSourceSnapshotChecksum(
  normalizedRows: Array<{ supplierSku: string; catalogTotal: number | null }>
): string {
  const sorted = [...normalizedRows].sort((a, b) =>
    a.supplierSku.localeCompare(b.supplierSku)
  )
  const canonical = sorted
    .map((r) => `${r.supplierSku}:${r.catalogTotal ?? "null"}`)
    .join("|")
  return createHash("sha256").update(canonical).digest("hex")
}
