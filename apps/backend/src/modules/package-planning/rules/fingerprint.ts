import { createHash } from "node:crypto"

/**
 * Identidad de un PackagePlan (plan §43) — mismo patrón que
 * `computeAllocationFingerprint` (Etapa 6) y `computeReadinessFingerprint`
 * (Etapa 7). Si cualquier insumo cambia (contenido de la allocation para
 * ese origen, peso/dimensiones reales usados, versión de la política de
 * empaque), el hash cambia -- señal de que el plan vigente debe
 * superseder-se y recalcularse.
 */
export function computePackagePlanFingerprint(input: {
  allocationSnapshotId: string
  supplierWarehouseId: string
  lines: Array<{ variantId: string; quantity: number; weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null }>
  packingRuleVersion: string
}): string {
  const canonicalLines = [...input.lines]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map((l) => `${l.variantId}:${l.quantity}:${l.weightKg ?? "null"}:${l.lengthCm ?? "null"}:${l.widthCm ?? "null"}:${l.heightCm ?? "null"}`)
    .join("|")

  const canonical = [
    input.allocationSnapshotId,
    input.supplierWarehouseId,
    canonicalLines,
    input.packingRuleVersion,
  ].join("#")

  return createHash("sha256").update(canonical).digest("hex")
}
