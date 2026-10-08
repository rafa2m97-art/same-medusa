import { MedusaError } from "@medusajs/framework/utils"
import type { ShippingLabelProvider } from "./types"

/**
 * Resolución por CONTENEDOR del `ShippingLabelProvider` activo --
 * mismo patrón que `SHIPPING_RATE_PROVIDER` (Etapa 8) y
 * `SUPPLIER_ADAPTER_REGISTRY` (Etapa 7): nunca `new EnviaLabelAdapter()`
 * directo desde el workflow. Clave DISTINTA de
 * `SHIPPING_RATE_PROVIDER` a propósito -- son dos capacidades
 * separadas (plan §39), pueden incluso resolver a adapters diferentes
 * sin que nada en el dominio lo note.
 */

export const SHIPPING_LABEL_PROVIDER = "shippingLabelProvider"

export function resolveShippingLabelProvider(container: {
  resolve: (key: string) => unknown
}): ShippingLabelProvider {
  try {
    return container.resolve(SHIPPING_LABEL_PROVIDER) as ShippingLabelProvider
  } catch {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No hay ShippingLabelProvider registrado bajo la clave "${SHIPPING_LABEL_PROVIDER}"`
    )
  }
}
