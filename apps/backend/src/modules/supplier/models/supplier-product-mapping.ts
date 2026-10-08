import { model } from "@medusajs/framework/utils"
import Supplier from "./supplier"
import SupplierProductState from "./supplier-product-state"
import SyncConflict from "./sync-conflict"

/**
 * Une un ProductVariant de Medusa con su identidad en UN proveedor dado.
 *
 * Una misma Variant puede tener VARIOS mappings (uno por proveedor) — este
 * modelo nunca asume que una variante solo tiene un proveedor. La unicidad
 * real es (supplier_id, variant_id), no variant_id sola.
 *
 * ---- Decisión Etapa 3, punto 1: variant_id (campo plano) + Module Link ----
 *
 * `variant_id` es la fuente CANÓNICA de la asociación con ProductVariant.
 * El Module Link (src/links/supplier-product-mapping-variant.ts) es una
 * PROYECCIÓN derivada de este campo — nunca una segunda fuente de verdad
 * independiente. Razón para mantener ambos (no solo el Link):
 *
 *   1. El Link por sí solo no puede expresar la unique constraint real
 *      (supplier_id, variant_id) a nivel de base de datos — la tabla pivote
 *      del Link no conoce supplier_id (vive en SupplierProductMapping).
 *   2. Consultar "¿qué mapping tiene este supplier para esta variant?"
 *      directo contra supplier_product_mapping (filtro plano) es más simple
 *      y más barato que un remoteQuery/Query Graph para el camino caliente
 *      de reconciliación (Etapa 3 recorre miles de mappings por SyncRun).
 *   3. El Link SÍ vale la pena mantenerlo para que la Admin API/Query Graph
 *      pueda expandir `variant.supplier_product_mappings` sin código custom.
 *
 * Mecanismo que evita la divergencia (variant_id = A pero el Link -> B):
 * crear/actualizar un SupplierProductMapping (específicamente cuando cambia
 * variant_id) DEBE pasar por los workflows en workflows/create-supplier
 * -product-mapping.ts / relink-supplier-product-mapping-variant.ts, que
 * ejecutan el write del modelo y createRemoteLinkStep/dismissRemoteLinkStep
 * como steps del MISMO workflow (compensación automática del motor de
 * Workflows de Medusa si un paso falla — mismo patrón que usa el propio
 * create-products.js de Medusa para Product<->SalesChannel). Nunca se debe
 * mutar variant_id con un UPDATE directo al servicio fuera de ese workflow
 * en código de aplicación real (sí se usa el service directo en tests de
 * esta etapa, que no tocan el Link, a propósito — ver supplier-product-
 * mapping-variant-link.spec.ts para el test de consistencia real).
 *
 * supplier_sku y supplier_internal_ref son campos DISTINTOS a propósito: el
 * proveedor puede recodificar su referencia interna sin avisar manteniendo
 * el mismo SKU (pasó de verdad: 567 falsos positivos la primera vez que se
 * asumió que eran lo mismo). Comparar ambos antes de concluir que un
 * producto "desapareció" del proveedor es responsabilidad de Etapa 3
 * (reconciliación) — ver reconciliation/classify-conflicts.ts.
 *
 * ---- Decisión Etapa 3, punto 2: cuarentena SÍ se separa ----
 *
 * Los campos de cuarentena (is_quarantined, quarantine_reason, etc.) que
 * vivían aquí en Etapa 2 se MUEVEN a SupplierProductState (modelo nuevo,
 * 1:1 con este). Razón del cambio de postura: este modelo responde "¿qué
 * producto del proveedor es esta variante?" — una pregunta de identidad que
 * cambia raramente (alta de producto, recodificación ocasional). El estado
 * de cuarentena cambia en CADA SyncRun (potencialmente a diario, por cada
 * uno de miles de mappings), tiene su propio ciclo de vida de escritura, y
 * acumula campos operacionales (last_evaluated_at, contadores, snapshots de
 * los últimos totales vistos) que no son parte de "qué es este producto".
 * Separar evita que una tabla de identidad reciba miles de UPDATEs diarios
 * por una razón que no tiene nada que ver con la identidad, y deja el
 * historial de confianza en un solo lugar con su propia forma. Ver
 * models/supplier-product-state.ts.
 */
const SupplierProductMapping = model.define("supplier_product_mapping", {
  id: model.id().primaryKey(),
  variant_id: model.text(),
  supplier_sku: model.text(),
  supplier_internal_ref: model.text().nullable(),
  status: model.enum(["active", "inactive"]).default("active"),
  metadata: model.json().nullable(),
  supplier: model.belongsTo(() => Supplier, { mappedBy: "product_mappings" }),
  state: model.hasOne(() => SupplierProductState, {
    mappedBy: "supplier_product_mapping",
  }),
  conflicts: model.hasMany(() => SyncConflict, {
    mappedBy: "supplier_product_mapping",
  }),
}).indexes([
  {
    on: ["supplier_id", "variant_id"],
    unique: true,
  },
  {
    on: ["supplier_id", "supplier_sku"],
  },
])

export default SupplierProductMapping
