import { model } from "@medusajs/framework/utils"
import Supplier from "./supplier"

/**
 * Un almacén que pertenece a un proveedor.
 *
 * `external_code` (ej. "MTY", "GD") NO es globalmente único — la identidad
 * real es (supplier_id, external_code), porque dos proveedores distintos
 * podrían usar el mismo código de almacén algún día. GD/MX/MY/TR son datos
 * de Exel, no constantes del dominio: no aparecen en ningún lado de este
 * módulo, solo existirán como filas reales creadas por el adaptador de Exel.
 *
 * Se vincula con un StockLocation nativo de Medusa vía Module Link
 * (src/links/supplier-warehouse-stock-location.ts), nunca duplicando esa
 * entidad aquí.
 *
 * `postal_code`/`district`/`phone` (Etapa 8, plan §34): "cada
 * SupplierWarehouse debe tener suficiente información para cotizar...
 * si faltan datos, fallar explícitamente, nunca inventar origins."
 * Nullable a propósito -- un almacén sin estos datos sigue siendo un
 * origen válido para Routing (Etapa 6, nunca los necesitó), pero
 * Package Planning (Etapa 8) debe rechazar explícitamente cotizar
 * envío desde él hasta que se completen (ver workflows/plan-and-quote-
 * shipping.ts). `district` (colonia) es REQUERIDO por Paquetexpress
 * según evidencia real confirmada por SSH 2026-10-05
 * (`same_get_envia_origin_geo_fields`, comentario real: "Paquetexpress
 * la exige... area_level3 se llenaba duplicando la ciudad" antes de
 * ese fix) -- nunca se deriva de `city`, se guarda explícito.
 */
const SupplierWarehouse = model.define("supplier_warehouse", {
  id: model.id().primaryKey(),
  external_code: model.text(),
  name: model.text(),
  status: model.enum(["active", "inactive"]).default("active"),
  address: model.text().nullable(),
  district: model.text().nullable(),
  city: model.text().nullable(),
  state: model.text().nullable(),
  country: model.text().nullable(),
  postal_code: model.text().nullable(),
  phone: model.text().nullable(),
  latitude: model.float().nullable(),
  longitude: model.float().nullable(),
  metadata: model.json().nullable(),
  supplier: model.belongsTo(() => Supplier, { mappedBy: "warehouses" }),
}).indexes([
  {
    on: ["supplier_id", "external_code"],
    unique: true,
  },
])

export default SupplierWarehouse
