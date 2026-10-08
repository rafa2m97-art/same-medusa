import { MedusaError } from "@medusajs/framework/utils"
import type { SupplierAdapter } from "../supplier/types"

/**
 * Resuelve QUÉ instancia de `SupplierAdapter` corresponde a un
 * `Supplier.adapter_key` -- nunca un `if (adapterKey === "exel")`
 * disperso por el código de Checkout (plan §12: "No llamar directamente
 * a ExelAdapter desde Checkout"). Inyección por CONTENEDOR, mismo
 * patrón que `resolveCommerceAuditEmitter` (Etapa 4): el motor de
 * Workflows serializa el input/output de cada step, así que una
 * instancia de clase con métodos (el adapter) debe resolverse DENTRO
 * del step, nunca pasarse como dato de workflow.
 *
 * En producción real, el registro se construye una vez al boot con
 * `new ExelAdapter({apiKey: process.env.EXEL_API_KEY})` bajo la clave
 * "exel_del_norte". En tests, se registra un `FakeSupplierAdapter` bajo
 * cualquier clave (incluida una "syscom_ficticio" inerte) -- nunca se
 * construye un adapter real de Syscom (plan §16).
 */

export const SUPPLIER_ADAPTER_REGISTRY = "supplierAdapterRegistry"

export interface SupplierAdapterRegistry {
  resolve(adapterKey: string): SupplierAdapter
}

export class MapSupplierAdapterRegistry implements SupplierAdapterRegistry {
  constructor(private readonly adaptersByKey: Map<string, SupplierAdapter>) {}

  resolve(adapterKey: string): SupplierAdapter {
    const adapter = this.adaptersByKey.get(adapterKey)
    if (!adapter) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `No hay SupplierAdapter registrado para adapter_key "${adapterKey}"`
      )
    }
    return adapter
  }
}

export function resolveSupplierAdapterRegistry(container: {
  resolve: (key: string) => unknown
}): SupplierAdapterRegistry {
  return container.resolve(SUPPLIER_ADAPTER_REGISTRY) as SupplierAdapterRegistry
}
