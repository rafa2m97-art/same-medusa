import { createHash } from "node:crypto"

/**
 * Identidad de un CheckoutReadiness (plan §31) — mismo patrón que
 * `computeSourceSnapshotChecksum` (Etapa 3) y
 * `computeAllocationFingerprint` (Etapa 6): si cualquier insumo cambia,
 * el hash cambia, y un cambio de hash es la señal de "hay que rehacer
 * los guards" (plan §32).
 *
 * Incluye explícitamente lo pedido: cart fingerprint (de la allocation
 * vigente, Etapa 6), allocation snapshot id, versión/precio
 * autorizado, shipping quote id, destino, y los ids de reserva/
 * confirmación de proveedor que participaron -- nunca datos de
 * cliente sensibles (teléfono/dirección completa), solo ids.
 */
export function computeReadinessFingerprint(input: {
  cartFingerprint: string
  allocationSnapshotId: string
  authorizedAmount: number
  currencyCode: string
  shippingQuoteId: string
  reservationIds: string[]
  supplierConfirmedAt: string | null
}): string {
  const canonical = [
    input.cartFingerprint,
    input.allocationSnapshotId,
    input.authorizedAmount,
    input.currencyCode.toLowerCase(),
    input.shippingQuoteId,
    [...input.reservationIds].sort().join(","),
    input.supplierConfirmedAt ?? "",
  ].join("#")

  return createHash("sha256").update(canonical).digest("hex")
}
