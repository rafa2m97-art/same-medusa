/**
 * Candado duro de producción (plan §38) — comprar una guía real cuesta
 * dinero real. Requiere que TRES condiciones sean verdaderas a la vez;
 * ninguna variable sola puede activar una compra real por accidente.
 *
 * `ENVIA_LABEL_PURCHASE_ENABLED` default `false` (plan §38, explícito)
 * -- si la variable no existe, el resultado es exactamente igual que
 * si existiera en `"false"`.
 */

export interface ProductionLockEnvironment {
  enviaEnvironment: string | undefined // "production" | "sandbox" | undefined
  labelPurchaseEnabledFlag: string | undefined // ENVIA_LABEL_PURCHASE_ENABLED
  productionUnlockedFlag: string | undefined // ENVIA_PRODUCTION_UNLOCKED
}

export function isRealLabelPurchaseAllowed(env: ProductionLockEnvironment): boolean {
  const environmentIsProduction = env.enviaEnvironment === "production"
  const labelPurchaseEnabled = env.labelPurchaseEnabledFlag === "true"
  const productionUnlocked = env.productionUnlockedFlag === "true"

  return environmentIsProduction && labelPurchaseEnabled && productionUnlocked
}
