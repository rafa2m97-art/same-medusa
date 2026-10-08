import { model } from "@medusajs/framework/utils"

/**
 * El costo MÁS RECIENTE que un proveedor reportó para un
 * SupplierProductMapping — nunca un precio público, nunca expuesto al
 * storefront. "¿Cuánto me cuesta esto?", no "¿cuánto lo vendo?" (ver
 * principio de Etapa 5).
 *
 * `supplier_product_mapping_id` es un campo plano (no una relación
 * MikroORM) porque `SupplierProductMapping` vive en el módulo `supplier`
 * — igual que `variant_id` en `SupplierProductMapping` (Etapa 2/3): un
 * módulo nunca tiene una FK real hacia otro módulo.
 *
 * 1:1 con el mapping (unique) — este modelo es "la última lectura", no un
 * historial. Igual que `SupplierProductState`, se sobreescribe en cada
 * SyncRun; NO es donde vive la decisión de confiar o no en ese costo (eso
 * es `PricingState`, ver pricing-state.ts) ni el último precio público
 * válido (eso también es `PricingState` — Last Known Good vive un nivel
 * arriba, nunca aquí).
 *
 * Verificado contra evidencia real (same_product_contract.py,
 * resolve_current_price()): Exel entrega un costo ÚNICO por producto, sin
 * dimensión de almacén — por eso este modelo NO tiene warehouse_id. Si un
 * proveedor futuro sí tuviera costo por almacén, eso se modela agregando
 * un campo opcional en una etapa futura, no inventándolo ahora sin
 * evidencia (ver plan Etapa 5 §4).
 *
 * `currency_code` existe aunque hoy SAME solo opera en MXN — para que
 * `classifyPriceChange()` pueda rechazar explícitamente una moneda no
 * soportada en vez de asumir conversión (ver reglas §15).
 */
const SupplierCost = model.define("supplier_cost", {
  id: model.id().primaryKey(),
  supplier_product_mapping_id: model.text(),
  currency_code: model.text(),
  amount: model.bigNumber(),
  source_sync_run_id: model.text().nullable(),
  effective_at: model.dateTime(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["supplier_product_mapping_id"],
    unique: true,
  },
])

export default SupplierCost
