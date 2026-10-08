import BigNumber from "bignumber.js"

/**
 * Decisión PURA sobre la MAGNITUD de un cambio de precio — separada de
 * I/O, igual que `classifyConflicts` (Etapa 3) y `planInventoryApply`
 * (Etapa 4).
 *
 * Re-alcance Etapa 5.1: en Etapa 5 esta función también decidía si la
 * FUENTE era confiable (mapping activo, quarantined, costo válido,
 * moneda soportada). Esa responsabilidad se movió a
 * `pricing-source-strategy.ts::evaluateCandidateEligibility` — ahora
 * esta función solo recibe el costo de una fuente YA elegible, y
 * responde una pregunta distinta: "¿es razonable el PRECIO que resulta
 * de este costo, comparado con el último aceptado?" Por eso ya no existe
 * un resultado REJECT aquí — un dato objetivamente inválido nunca llega
 * tan lejos (la fuente ya fue descartada como inelegible antes).
 *
 * Principio de Etapa 5: Supplier dice "esto me cuesta X" — Pricing
 * decide "SAME lo vende en Y". Esas dos cifras nunca se confunden aquí.
 */

export type PriceChangeReviewReason = "extreme_price_change"

export type PriceChangeClassification =
  | {
      action: "ACCEPT"
      publicPriceAmount: number
      policyCode: string
    }
  | {
      action: "REVIEW"
      reason: PriceChangeReviewReason
      computedAmount: number
      previousAmount: number
      ratio: number
      policyCode: string
    }

export interface PricingPolicyInput {
  code: string
  currencyCode: string
  /** 0.95 = "el costo representa el 95% del precio antes de impuesto" — semántica real, no "5% de margen sumado". */
  marginFactor: number
  /** 1.16 = IVA 16%. */
  taxFactor: number
  /**
   * Banda de variación segura día-a-día (Etapa 5.1, plan §15) —
   * versionada en PricingPolicy, nunca una constante de código. NO existe
   * en el sistema real hoy (verificado por SSH 2026-10-03:
   * `actualizar_precios_cli.php` aplica cualquier precio nuevo sin ningún
   * guard de variación; el único guard real,
   * `MIN_SALE_PRICE_RATIO=0.5` en same_product_contract.py, compara
   * precio de OFERTA vs. REGULAR dentro del MISMO snapshot, nunca ayer
   * vs. hoy) — protección NUEVA de SAME, diseñada para el hallazgo real
   * del plan (10,000 -> 500).
   */
  minChangeRatio: number
  maxChangeRatio: number
}

export interface ClassifyPriceChangeInput {
  costAmount: number
  policy: PricingPolicyInput
  /** `null` = nunca se ha aceptado un precio para esta variant todavía (primer precio). */
  lastAcceptedAmount: number | null
}

/**
 * Dinero calculado con aritmética decimal exacta (bignumber.js), nunca
 * con floats de JS crudos — `100 / 0.95 * 1.16` en float ya es
 * 122.10000000000001 en vez de 122.1 exacto, y hay costos reales donde
 * ese error de representación cruza el límite de un entero (ej. 95 ->
 * 115.99999999999999 en floats). `Decimal` en el Python real
 * (same_product_contract.py, ROUND_CEILING) hace exactamente este mismo
 * trabajo — aquí se preserva la misma garantía con bignumber.js en vez
 * de reinventar una librería decimal propia.
 */
function computePublicPrice(costAmount: number, policy: PricingPolicyInput): number {
  const withMargin = new BigNumber(costAmount).dividedBy(policy.marginFactor)
  const withTax = withMargin.multipliedBy(policy.taxFactor)
  return withTax.integerValue(BigNumber.ROUND_CEIL).toNumber()
}

export function classifyPriceChange(
  input: ClassifyPriceChangeInput
): PriceChangeClassification {
  const computedAmount = computePublicPrice(input.costAmount, input.policy)

  if (input.lastAcceptedAmount === null) {
    // Primer precio para esta variant — nada contra qué comparar.
    return { action: "ACCEPT", publicPriceAmount: computedAmount, policyCode: input.policy.code }
  }

  const ratio = computedAmount / input.lastAcceptedAmount
  if (ratio < input.policy.minChangeRatio || ratio > input.policy.maxChangeRatio) {
    return {
      action: "REVIEW",
      reason: "extreme_price_change",
      computedAmount,
      previousAmount: input.lastAcceptedAmount,
      ratio,
      policyCode: input.policy.code,
    }
  }

  return { action: "ACCEPT", publicPriceAmount: computedAmount, policyCode: input.policy.code }
}
