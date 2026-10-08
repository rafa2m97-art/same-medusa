import { model } from "@medusajs/framework/utils"
import SupplierWarehouse from "./supplier-warehouse"
import SupplierProductMapping from "./supplier-product-mapping"
import SyncRun from "./sync-run"

/**
 * Entidad de negocio que representa un proveedor de dropshipping (Exel del
 * Norte hoy; CVA/CT/Ingram/etc. mañana sin cambiar este modelo).
 *
 * No guarda credenciales ni secretos — `adapter_key` solo identifica QUÉ
 * implementación de SupplierAdapter usar (ver src/integrations/suppliers/),
 * nunca cómo autenticarse. Las API keys viven en variables de entorno.
 *
 * `is_primary_pricing_source` (Etapa 5.1): configuración explícita de CUÁL
 * proveedor puede servir como fuente del costo para el precio público —
 * nunca "el último que sincronizó". Vive aquí (no en una tabla de
 * configuración aparte) porque es, en esencia, un atributo del propio
 * Supplier, igual de simple que `status`; una estrategia futura más rica
 * (PREFERRED_ORDER, por ejemplo) podría necesitar un campo de prioridad
 * numérica, pero eso se agrega cuando exista esa estrategia real — hoy
 * solo PRIMARY_SUPPLIER existe, y un booleano es exactamente lo que
 * necesita (ver reconciliation/pricing-source-strategy.ts). Pricing Source
 * Selection (qué costo determina el precio) es una decisión DISTINTA de
 * Routing/Sourcing (qué proveedor surte físicamente) — este campo nunca
 * debe leerse como "el proveedor que cumplirá el pedido".
 */
const Supplier = model.define("supplier", {
  id: model.id().primaryKey(),
  code: model.text().unique(),
  name: model.text(),
  status: model.enum(["active", "inactive"]).default("active"),
  adapter_key: model.text(),
  is_primary_pricing_source: model.boolean().default(false),
  metadata: model.json().nullable(),
  warehouses: model.hasMany(() => SupplierWarehouse, { mappedBy: "supplier" }),
  product_mappings: model.hasMany(() => SupplierProductMapping, {
    mappedBy: "supplier",
  }),
  sync_runs: model.hasMany(() => SyncRun, { mappedBy: "supplier" }),
})

export default Supplier
