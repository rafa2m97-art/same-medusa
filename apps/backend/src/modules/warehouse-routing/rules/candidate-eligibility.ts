/**
 * "¿Puedo confiar en este origen EN ABSOLUTO?" — separado de "¿cuál es
 * el mejor origen?" (eso es allocate-cart.ts), mismo principio que
 * `evaluateCandidateEligibility` en pricing-rules/rules/pricing-source-
 * strategy.ts (Etapa 5.1): la elegibilidad de la FUENTE nunca se mezcla
 * con el ranking/optimización. `allocateCart()` asume que todo
 * `RoutingCandidate` que recibe ya es elegible — este filtro corre
 * ANTES, en el workflow.
 *
 * Reglas, pedidas explícitamente: proveedor activo, SupplierWarehouse
 * activo, SupplierProductMapping activo, mapping NO quarantined
 * (reutiliza el mismo criterio de confianza que ya gobierna Inventory,
 * Etapa 4 — un producto en cuarentena nunca debe ofrecerse como origen
 * de fulfillment, aunque tenga stock cacheado), y stock no obsoleto
 * (`staleAfterMs`, mismo concepto que `MAX_COST_AGE_MS` en Pricing).
 */

export type RoutingCandidateIneligibilityReason =
  | "supplier_inactive"
  | "warehouse_inactive"
  | "mapping_inactive"
  | "quarantined"
  | "stale_inventory"

export interface RoutingCandidateInput {
  supplierStatus: "active" | "inactive"
  warehouseStatus: "active" | "inactive"
  mappingStatus: "active" | "inactive"
  supplierProductStateStatus: "active" | "quarantined" | null
  /** Último momento en que se confirmó este nivel de inventario (ej. `SupplierProductState.last_apply_at`). `null` = nunca confirmado -> se trata como obsoleto. */
  inventoryConfirmedAt: Date | null
}

export interface RoutingEligibilityOptions {
  maxInventoryAgeMs: number
  now: Date
}

export interface RoutingEligibilityResult {
  eligible: boolean
  reason?: RoutingCandidateIneligibilityReason
}

export function evaluateRoutingCandidateEligibility(
  candidate: RoutingCandidateInput,
  options: RoutingEligibilityOptions
): RoutingEligibilityResult {
  if (candidate.supplierStatus !== "active") {
    return { eligible: false, reason: "supplier_inactive" }
  }
  if (candidate.warehouseStatus !== "active") {
    return { eligible: false, reason: "warehouse_inactive" }
  }
  if (candidate.mappingStatus !== "active") {
    return { eligible: false, reason: "mapping_inactive" }
  }
  if (candidate.supplierProductStateStatus === "quarantined") {
    return { eligible: false, reason: "quarantined" }
  }
  if (
    !candidate.inventoryConfirmedAt ||
    options.now.getTime() - candidate.inventoryConfirmedAt.getTime() > options.maxInventoryAgeMs
  ) {
    return { eligible: false, reason: "stale_inventory" }
  }
  return { eligible: true }
}
