import { MedusaError } from "@medusajs/framework/utils"
import type { ShippingRateProvider } from "./types"

/**
 * Resolución por CONTENEDOR del `ShippingRateProvider` activo (plan
 * §4/§35) -- nunca `new EnviaAdapter()` directo desde el workflow de
 * Package Planning. A diferencia de `SupplierAdapterRegistry` (Etapa
 * 7, multi-proveedor), aquí basta una clave única porque solo existe
 * UNA integración de envío activa a la vez -- en producción real hoy
 * sería `EnviaAdapter`; en tests, `FakeShippingRateProvider`.
 */

export const SHIPPING_RATE_PROVIDER = "shippingRateProvider"

export function resolveShippingRateProvider(container: {
  resolve: (key: string) => unknown
}): ShippingRateProvider {
  try {
    return container.resolve(SHIPPING_RATE_PROVIDER) as ShippingRateProvider
  } catch {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No hay ShippingRateProvider registrado bajo la clave "${SHIPPING_RATE_PROVIDER}"`
    )
  }
}
