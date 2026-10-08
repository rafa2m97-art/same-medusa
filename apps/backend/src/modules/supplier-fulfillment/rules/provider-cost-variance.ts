/**
 * Política ACCEPT/REVIEW/REJECT para la diferencia entre el
 * `provider_amount` COTIZADO (Etapa 8) y el costo REAL que Envia cobra
 * al comprar la guía (plan §15).
 *
 * IMPORTANTE -- evidencia real revisada (SSH 2026-10-06): el flujo hoy
 * vigente (n8n + Skydropx, `class-samepay-shipping-integration.php`)
 * NO tiene ninguna política de tolerancia -- simplemente acepta y
 * guarda el `tracking_number`/costo que Skydropx devuelva, sin
 * comparar contra nada cotizado antes. Por lo tanto, este umbral es
 * una MEJORA NUEVA del backend (nunca una preservación de una regla
 * real) -- se deja explícitamente configurable (nunca un magic number
 * fijo en código, mismo principio que `PricingPolicy.min/
 * max_change_ratio`, Etapa 5.1) para que el usuario pueda ajustarlo
 * con evidencia real una vez que haya cotizaciones reales con qué
 * comparar.
 *
 * El label YA se compró (dinero real ya se movió) -- esta política
 * NUNCA deshace esa compra; solo decide si el WarehouseShipment puede
 * avanzar automáticamente a envío al proveedor (ACCEPT) o debe
 * detenerse para revisión humana (REVIEW/REJECT), siempre conservando
 * el tracking/label ya obtenidos (plan §15: "no modificar lo que ya
 * pagó el cliente").
 */

export interface ProviderCostVariancePolicy {
  /** Ej. 0.2 = tolera hasta 20% de diferencia en cualquier dirección antes de requerir revisión. */
  maxAcceptableVarianceRatio: number
  /** Ej. 1.0 = 100% más caro (el doble) ya se trata como REJECT en vez de solo REVIEW. */
  rejectVarianceRatio: number
}

export type ProviderCostVarianceVerdict = "ACCEPT" | "REVIEW" | "REJECT"

export function evaluateProviderCostVariance(
  quotedAmount: number | null,
  actualAmount: number,
  policy: ProviderCostVariancePolicy
): ProviderCostVarianceVerdict {
  if (quotedAmount === null || quotedAmount <= 0) {
    // Sin cotización contra qué comparar -- no se puede evaluar
    // variación, pero tampoco se bloquea una compra real ya hecha.
    return "ACCEPT"
  }

  const variance = Math.abs(actualAmount - quotedAmount) / quotedAmount

  if (variance > policy.rejectVarianceRatio) return "REJECT"
  if (variance > policy.maxAcceptableVarianceRatio) return "REVIEW"
  return "ACCEPT"
}
