/**
 * Etapa 5.1 — elimina la regla implícita "el último proveedor que
 * sincronizó define el precio". Pricing Source Selection responde:
 * "¿qué costo/origen utilizo para construir el precio que verá el
 * cliente?" — una pregunta DISTINTA de Routing/Sourcing ("¿qué proveedor
 * surtirá físicamente este carrito?", Etapa 6+). Esta capa nunca decide
 * fulfillment ni conoce stock — solo confiabilidad de la FUENTE del costo.
 *
 * Todo lo de aquí es PURO (sin I/O) — el resolver que junta los
 * candidatos reales desde Supplier/SupplierProductMapping/
 * SupplierProductState/SupplierCost vive en
 * workflows/apply-supplier-pricing.ts, nunca aquí.
 */

export type PricingCandidateIneligibilityReason =
  | "supplier_inactive"
  | "mapping_inactive"
  | "quarantined"
  | "missing_cost"
  | "invalid_cost"
  | "unsupported_currency"
  | "stale_cost"

/**
 * La "oferta" que UN proveedor tiene hoy para una Variant — derivada,
 * nunca persistida como tabla propia (plan §3: "no copies estos campos
 * ciegamente, no quiero duplicar datos si pueden derivarse").
 */
export interface PricingSourceCandidate {
  supplierId: string
  supplierCode: string
  mappingId: string
  isPrimaryPricingSource: boolean
  supplierStatus: "active" | "inactive"
  mappingStatus: "active" | "inactive"
  supplierProductStateStatus: "active" | "quarantined" | null
  costAmount: number | null
  costCurrencyCode: string | null
  costEffectiveAt: Date | null
}

export interface EvaluatedPricingCandidate {
  candidate: PricingSourceCandidate
  eligible: boolean
  ineligibilityReason?: PricingCandidateIneligibilityReason
}

export interface EligibilityOptions {
  requiredCurrencyCode: string
  maxCostAgeMs: number
  now: Date
}

/**
 * "validity/trust" (¿puedo confiar en esta fuente en absoluto?) — nunca
 * "fulfillment optimization" (¿cuánto stock tiene?, pertenece a Routing).
 * Ningún criterio de aquí mira inventario.
 */
export function evaluateCandidateEligibility(
  candidate: PricingSourceCandidate,
  options: EligibilityOptions
): EvaluatedPricingCandidate {
  if (candidate.supplierStatus !== "active") {
    return { candidate, eligible: false, ineligibilityReason: "supplier_inactive" }
  }
  if (candidate.mappingStatus !== "active") {
    return { candidate, eligible: false, ineligibilityReason: "mapping_inactive" }
  }
  if (candidate.supplierProductStateStatus === "quarantined") {
    return { candidate, eligible: false, ineligibilityReason: "quarantined" }
  }
  if (candidate.costAmount === null || candidate.costCurrencyCode === null) {
    return { candidate, eligible: false, ineligibilityReason: "missing_cost" }
  }
  if (
    !Number.isFinite(candidate.costAmount) ||
    Number.isNaN(candidate.costAmount) ||
    candidate.costAmount <= 0
  ) {
    return { candidate, eligible: false, ineligibilityReason: "invalid_cost" }
  }
  if (candidate.costCurrencyCode.toLowerCase() !== options.requiredCurrencyCode.toLowerCase()) {
    return { candidate, eligible: false, ineligibilityReason: "unsupported_currency" }
  }
  if (
    candidate.costEffectiveAt &&
    options.now.getTime() - candidate.costEffectiveAt.getTime() > options.maxCostAgeMs
  ) {
    return { candidate, eligible: false, ineligibilityReason: "stale_cost" }
  }
  return { candidate, eligible: true }
}

export type PricingSourceSelectionReason =
  | "primary_selected"
  | "primary_not_configured"
  | PricingCandidateIneligibilityReason

export interface PricingSourceSelection {
  strategy: "PRIMARY_SUPPLIER"
  selected: PricingSourceCandidate | null
  reason: PricingSourceSelectionReason
}

export interface PricingSourceStrategy {
  readonly name: "PRIMARY_SUPPLIER"
  selectSource(evaluated: EvaluatedPricingCandidate[]): PricingSourceSelection
}

/**
 * Única estrategia implementada en Etapa 5.1 (plan §5/§7) — determinista:
 * el MISMO conjunto de candidatos SIEMPRE produce la MISMA selección, sin
 * importar en qué orden llegaron los syncs que los generaron. Si el
 * primario no es elegible, NO gana automáticamente otro proveedor
 * (pedido explícito, plan §6) — eso requeriría una política de fallback
 * explícita que todavía no existe.
 */
export class PrimarySupplierStrategy implements PricingSourceStrategy {
  readonly name = "PRIMARY_SUPPLIER" as const

  selectSource(evaluated: EvaluatedPricingCandidate[]): PricingSourceSelection {
    const primary = evaluated.find((e) => e.candidate.isPrimaryPricingSource)

    if (!primary) {
      return { strategy: this.name, selected: null, reason: "primary_not_configured" }
    }
    if (!primary.eligible) {
      return {
        strategy: this.name,
        selected: null,
        reason: primary.ineligibilityReason ?? "primary_not_configured",
      }
    }
    return { strategy: this.name, selected: primary.candidate, reason: "primary_selected" }
  }
}
