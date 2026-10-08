import type { CheckoutGuardFailure } from "./taxonomy"

/**
 * Price Guard (plan §5/§7/§8) — Pricing (Etapa 5/5.1) es la autoridad;
 * este guard NUNCA recalcula margen/IVA/anomalías desde cero, solo
 * valida que la representación actual del carrito coincide con lo que
 * Medusa Pricing ya autorizó para esta variant AHORA MISMO. El I/O que
 * trae `authoritativeUnitPrice`/`isCalculatedPriceTaxInclusive` vía
 * `pricingModule.calculatePrices()` vive en el workflow, nunca aquí.
 *
 * Distingue explícitamente (plan §7):
 *   - precio inválido/peligroso -> bloquear (PRICE_INVALID);
 *   - precio sin confirmar todavía por Pricing -> bloquear
 *     (PRICE_REQUIRES_REVIEW, lee `PricingState.last_classification`,
 *     nunca una regla nueva aquí);
 *   - precio cambió legítimamente -> bloquear igual, pero con un código
 *     DISTINTO (PRICE_CHANGED) para que el frontend pueda explicar "tu
 *     carrito cambió de precio" en vez de un error genérico.
 *
 * Regresión obligatoria de Etapa 5 (plan §44/§9): el precio autoritativo
 * DEBE venir ya tax-inclusive -- si Medusa alguna vez calculara uno que
 * no lo es, este guard lo trata como inválido en vez de aceptarlo a
 * ciegas (sería un doble-IVA silencioso aguas abajo).
 */

export interface PriceGuardLineInput {
  variantId: string
  cartUnitPrice: number
  /** `null` = Medusa no pudo calcular un precio para esta variant ahora (price set ausente, moneda no soportada, etc). */
  authoritativeUnitPrice: number | null
  isCalculatedPriceTaxInclusive: boolean | null
  /** `PricingState.last_classification` -- `null` = nunca evaluado por Pricing. */
  lastPricingClassification: "ACCEPT" | "REVIEW" | null
}

export type PriceGuardResult =
  | { valid: true; authoritativeUnitPrice: number }
  | { valid: false; failure: CheckoutGuardFailure }

export function evaluatePriceGuardLine(input: PriceGuardLineInput): PriceGuardResult {
  if (input.lastPricingClassification === "REVIEW") {
    return {
      valid: false,
      failure: {
        failureCode: "PRICE_REQUIRES_REVIEW",
        failureStage: "PRICE_GUARD",
        details: { variantId: input.variantId },
      },
    }
  }

  if (
    input.authoritativeUnitPrice === null ||
    !Number.isFinite(input.authoritativeUnitPrice) ||
    input.authoritativeUnitPrice <= 0
  ) {
    return {
      valid: false,
      failure: {
        failureCode: "PRICE_INVALID",
        failureStage: "PRICE_GUARD",
        details: { variantId: input.variantId, reason: "no_authoritative_price" },
      },
    }
  }

  if (input.isCalculatedPriceTaxInclusive !== true) {
    return {
      valid: false,
      failure: {
        failureCode: "PRICE_INVALID",
        failureStage: "PRICE_GUARD",
        details: { variantId: input.variantId, reason: "not_tax_inclusive" },
      },
    }
  }

  if (input.authoritativeUnitPrice !== input.cartUnitPrice) {
    return {
      valid: false,
      failure: {
        failureCode: "PRICE_CHANGED",
        failureStage: "PRICE_GUARD",
        details: {
          variantId: input.variantId,
          cartUnitPrice: input.cartUnitPrice,
          authoritativeUnitPrice: input.authoritativeUnitPrice,
        },
      },
    }
  }

  return { valid: true, authoritativeUnitPrice: input.authoritativeUnitPrice }
}
