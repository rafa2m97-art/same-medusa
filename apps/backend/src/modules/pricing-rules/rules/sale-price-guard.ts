import BigNumber from "bignumber.js"

/**
 * Guard real del 50% (Etapa 7, plan §6) — verificado por SSH 2026-10-03
 * contra `/opt/exel_sync/same_product_contract.py`
 * (`determine_woocommerce_prices`, `MIN_SALE_PRICE_RATIO`), NO inventado.
 *
 * Hallazgos exactos de la evidencia real:
 *   - Motivo real (comentario en el código, fix 2026-09-01): el mouse
 *     Logitech Pebble 2 M350s Blanco se publicó a $59 en vez de ~$498
 *     durante más de 5 semanas porque Exel mandó un `precio_oferta`
 *     imposible (~$48) sin que nada lo detectara.
 *   - NO es "precio ayer vs. precio hoy" -- es "precio de OFERTA vs.
 *     precio REGULAR dentro del MISMO snapshot/lectura" (confirmado:
 *     ambos se derivan del mismo payload de Exel en la misma pasada).
 *   - La comparación ocurre DESPUÉS de convertir ambos crudos a precio
 *     público (margen+IVA ya aplicado a cada lado), nunca sobre los
 *     costos crudos de Exel directamente.
 *   - Solo se evalúa si AMBOS existen y son positivos, y si
 *     regular_publico > oferta_publico > 0 (una "oferta" mayor o igual
 *     al regular no es sospechosa, es simplemente un error de datos
 *     distinto que no corresponde a este guard).
 *   - Threshold exacto: 0.5 (`MIN_SALE_PRICE_RATIO`), ratio = oferta/regular.
 *   - Remedio real: NUNCA bloquea el producto ni lo manda a cuarentena
 *     -- descarta SOLO la oferta y publica el regular solo (oferta=null).
 *   - Ninguna exclusión por categoría/producto en el código real.
 *
 * Por qué vive en `pricing-rules/` y no en `checkout-guards/`: es un
 * guard de INGESTA de precio (corre cuando llega un costo nuevo del
 * proveedor, igual que `classifyPriceChange`), no una validación en el
 * momento de pagar -- Checkout's Price Guard (Etapa 7) solo compara el
 * precio YA ACEPTADO por Pricing contra el carrito, nunca vuelve a
 * aplicar esta regla (principio "Pricing es la autoridad, Checkout
 * valida consistencia", plan §8). Hoy `SupplierCost`/`classifyPriceChange`
 * (Etapa 5/5.1) solo modelan un costo único por mapping -- este guard
 * queda listo para cuando la ingesta real de Exel empiece a mandar
 * `precio_oferta`/`precio_sin_oferta` como dos valores separados (fuera
 * de alcance de Etapa 7 extender el modelo de ingesta en sí).
 */

export interface SalePriceGuardInput {
  regularCostAmount: number
  saleCostAmount: number
  marginFactor: number
  taxFactor: number
}

export type SalePriceGuardResult =
  | { accepted: true; regularPublicAmount: number; salePublicAmount: number }
  | { accepted: false; regularPublicAmount: number; reason: "sale_price_suspicious"; ratio: number }

const MIN_SALE_PRICE_RATIO = new BigNumber("0.5")

function toPublicAmount(costAmount: number, marginFactor: number, taxFactor: number): number {
  return new BigNumber(costAmount)
    .dividedBy(marginFactor)
    .multipliedBy(taxFactor)
    .integerValue(BigNumber.ROUND_CEIL)
    .toNumber()
}

export function evaluateSalePriceGuard(input: SalePriceGuardInput): SalePriceGuardResult {
  const regularPublicAmount = toPublicAmount(input.regularCostAmount, input.marginFactor, input.taxFactor)
  const salePublicAmount = toPublicAmount(input.saleCostAmount, input.marginFactor, input.taxFactor)

  if (!(regularPublicAmount > salePublicAmount && salePublicAmount > 0)) {
    // No es una "oferta" real (igual, mayor, o cero) -- fuera del alcance de este guard.
    return { accepted: true, regularPublicAmount, salePublicAmount }
  }

  const ratio = new BigNumber(salePublicAmount).dividedBy(regularPublicAmount)
  if (ratio.isGreaterThanOrEqualTo(MIN_SALE_PRICE_RATIO)) {
    return { accepted: true, regularPublicAmount, salePublicAmount }
  }

  return {
    accepted: false,
    regularPublicAmount,
    reason: "sale_price_suspicious",
    ratio: ratio.toNumber(),
  }
}
