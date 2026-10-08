import type { ConflictClassification } from "./types"

/**
 * Regla de salida de cuarentena — CORREGIDA respecto al borrador original
 * del plan ("2 syncs con stock > 0"), y generalizada respecto al único
 * mecanismo real que existe hoy en producción.
 *
 * Evidencia real (conflict_draft.php, sección "resolver conflictos ya
 * sanados", agregada 2026-09-24): el único chequeo que existe HOY compara
 * exactamente los DOS runs más recientes — "evita parpadeos por una sola
 * lectura" — y SOLO aplica a un tipo de cuarentena
 * (SOURCE_CONFLICT_TOTAL_VS_LOCATIONS); cualquier otro motivo de cuarentena
 * no tiene ninguna salida automática hoy, se queda así hasta revisión
 * humana.
 *
 * Aquí se generaliza esa idea a CUALQUIER motivo de cuarentena (mejora
 * deliberada) usando un contador persistente con umbral 2 en vez de "mirar
 * los 2 directorios de run más recientes" — equivalente en el caso simple,
 * pero no requiere que el llamador sepa nada de runs anteriores más que el
 * contador guardado.
 */
export interface QuarantineStateSnapshot {
  status: "active" | "quarantined"
  consecutiveConsistentRuns: number
}

const EXIT_THRESHOLD = 2

export function nextQuarantineState(
  prior: QuarantineStateSnapshot,
  classification: ConflictClassification
): QuarantineStateSnapshot {
  if (classification.action === "QUARANTINE") {
    // Cualquier QUARANTINE reinicia el contador, sin importar el motivo —
    // pedido explícito: "Run 1 ✅ / Run 2 ❌ -> el contador debe reiniciarse."
    return { status: "quarantined", consecutiveConsistentRuns: 0 }
  }

  // Tope en el umbral: para un mapping ya sano no tiene sentido que el
  // contador crezca sin límite para siempre.
  const consecutiveConsistentRuns = Math.min(
    prior.consecutiveConsistentRuns + 1,
    EXIT_THRESHOLD
  )
  const status = consecutiveConsistentRuns >= EXIT_THRESHOLD ? "active" : prior.status

  return { status, consecutiveConsistentRuns }
}
