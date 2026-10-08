/**
 * Resuelve la prioridad CONFIGURADA (RoutingRule) de un candidato para un
 * destino dado — generalización multi-proveedor de la tabla real hoy
 * hardcodeada en `same_get_allocation_proximity_rank()` (helpers.php,
 * verificado por SSH 2026-10-03): NL->MY, JAL->GD, COAH->TR, CDMX->MX.
 *
 * Puro a propósito (sin I/O): recibe las RoutingRule YA cargadas por el
 * workflow, nunca consulta la base de datos — así se puede probar con
 * cientos de combinaciones destino/candidato sin levantar nada.
 *
 * `null` = "no hay fila configurada para este candidato en este
 * destino" — nunca se inventa un valor; el llamador (allocate-cart.ts,
 * vía el workflow que ensambla cada RoutingCandidate) interpreta `null`
 * como "cae al fallback de distancia", nunca como "prioridad 0".
 */

export interface RoutingRuleEntry {
  destinationState: string
  supplierId: string
  supplierWarehouseId: string
  priority: number
  status: "active" | "inactive"
}

export interface RoutingRuleMatchCandidate {
  supplierId: string
  supplierWarehouseId: string
}

export function resolveConfiguredPriority(
  destinationState: string | null,
  rules: RoutingRuleEntry[],
  candidate: RoutingRuleMatchCandidate
): number | null {
  if (!destinationState) return null

  const normalizedDestination = destinationState.trim().toUpperCase()
  const match = rules.find(
    (rule) =>
      rule.status === "active" &&
      rule.destinationState === normalizedDestination &&
      rule.supplierId === candidate.supplierId &&
      rule.supplierWarehouseId === candidate.supplierWarehouseId
  )

  return match ? match.priority : null
}
