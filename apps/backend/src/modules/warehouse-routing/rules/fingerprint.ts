import { createHash } from "node:crypto"

/**
 * Identidad de un cálculo de allocation (mismo patrón que
 * `computeSourceSnapshotChecksum`, Etapa 3,
 * supplier/reconciliation/sync-run-identity.ts). Responde: "¿este
 * carrito, con este destino, es EXACTAMENTE el mismo que la última vez
 * que se calculó?" — para que el workflow pueda reutilizar la
 * AllocationSnapshot ACTIVE vigente en vez de crear una idéntica nueva
 * (idempotencia explícita, plan Etapa 6).
 *
 * Deliberadamente NO incluye el estado del inventario/candidatos — un
 * cambio de stock sí debe forzar un recálculo nuevo (eso lo decide el
 * workflow comparando contra `expires_at`/staleness, no este
 * fingerprint). Este fingerprint es solo sobre la INTENCIÓN del
 * carrito (qué se pidió, a dónde se envía), no sobre el inventario
 * disponible en el momento.
 */
export function computeAllocationFingerprint(input: {
  lines: Array<{ variantId: string; quantity: number }>
  destinationState: string | null
}): string {
  const canonicalLines = [...input.lines]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map((line) => `${line.variantId}:${line.quantity}`)
    .join("|")

  const canonical = `${canonicalLines}#${input.destinationState ?? ""}`
  return createHash("sha256").update(canonical).digest("hex")
}
