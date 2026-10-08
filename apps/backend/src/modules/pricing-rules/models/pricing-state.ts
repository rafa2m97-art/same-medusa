import { model } from "@medusajs/framework/utils"

/**
 * Last Known Good Price — el equivalente, para precios, de
 * `SupplierProductState` (Etapa 3) y de `last_applied_sync_run_*` en
 * Inventory (Etapa 4). Responde: "¿cuál es el último precio público que
 * SAME confirmó que es seguro mostrar, y de dónde salió?"
 *
 * RE-CLAVE Etapa 5.1 (deuda cerrada a propósito): en Etapa 5 esto era 1:1
 * con `SupplierProductMapping`. Con múltiples proveedores por Variant esa
 * clave ya no tiene sentido — el precio público, y su Last Known Good, es
 * una propiedad de la VARIANT (un solo precio visible), no de un mapping
 * concreto; qué mapping fue la fuente es informacion QUE ESTE MISMO
 * registro guarda (`source_mapping_id`), no la clave con la que se busca.
 * Por eso ahora es 1:1 con `variant_id` (campo plano, cross-módulo, mismo
 * patrón que en todo lo demás) — nunca con el mapping.
 *
 * `source_supplier_id`/`source_mapping_id`/`source_supplier_cost_id`
 * dejan trazable exactamente de dónde salió el precio actual, sin
 * necesidad de volver a correr la selección de fuente para saberlo
 * (pedido explícito, plan §9). `last_strategy` registra CUÁL estrategia
 * decidió (hoy solo "PRIMARY_SUPPLIER" existe) — necesario para auditar
 * un cambio de estrategia a futuro sin ambigüedad.
 *
 * Por qué se cachean `last_accepted_amount`/`last_accepted_cost_amount`
 * aquí en vez de solo leerlos de Medusa Pricing: la clasificación de un
 * costo NUEVO necesita comparar contra el último precio ACEPTADO de
 * inmediato (ver classify-price-change.ts) — ir a buscarlo vía
 * Link→PriceSet→Price en cada evaluación sería un viaje de más para un
 * dato de lectura caliente, igual que se decidió para SyncRun en Etapa 4.
 * Medusa Pricing sigue siendo la fuente de verdad del precio que el
 * storefront realmente usa; este campo es una copia de lectura rápida,
 * nunca la fuente de verdad.
 */
const PricingState = model.define("pricing_state", {
  id: model.id().primaryKey(),
  variant_id: model.text(),
  last_classification: model.enum(["ACCEPT", "REVIEW", "REJECT"]).nullable(),
  last_classification_reason: model.text().nullable(),
  last_strategy: model.text().nullable(),
  source_supplier_id: model.text().nullable(),
  source_mapping_id: model.text().nullable(),
  source_supplier_cost_id: model.text().nullable(),
  last_accepted_amount: model.bigNumber().nullable(),
  last_accepted_cost_amount: model.bigNumber().nullable(),
  last_applied_policy_code: model.text().nullable(),
  last_evaluated_at: model.dateTime().nullable(),
  last_accepted_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["variant_id"],
    unique: true,
  },
])

export default PricingState
