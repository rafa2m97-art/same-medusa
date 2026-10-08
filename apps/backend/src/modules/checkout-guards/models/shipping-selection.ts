import { model } from "@medusajs/framework/utils"

/**
 * UNA opción de envío COMPLETA del carrito (plan §20) — agrega una
 * `ShippingQuote` por origen en una sola cifra total. Evidencia real
 * (SSH 2026-10-05, `class-same-dynamic-shipping.php::
 * normalize_envia_shipments`): producción ya ofrece exactamente 3
 * opciones por carrito — "cheapest"/"fastest"/"recommended" (hoy
 * `recommended` es un alias literal de `cheapest`, no una heurística
 * propia) — y el CLIENTE elige una en el checkout (confirmado:
 * WooCommerce muestra las 3 como radios, nunca auto-selecciona).
 *
 * `service_level` preserva esos mismos 3 valores reales como default
 * (texto libre, no un enum cerrado, para no bloquear un cuarto nivel
 * futuro). Sin storefront todavía en este proyecto (plan §20 no exige
 * UI), el workflow de Etapa 8 genera las 3 y deja `recommended`
 * pre-seleccionada por defecto — exactamente lo que la API real
 * devuelve como "shipment.recommended" — pero
 * `select-shipping-option.ts` permite cambiarla explícitamente,
 * dejando listo el punto de extensión para cuando exista un storefront
 * real que permita al cliente elegir.
 *
 * Nunca mezcla carriers "incompatibles" entre orígenes sin que el
 * caller lo decida (plan §48) -- cada ShippingSelection es, por
 * construcción, UN mismo `service_level` aplicado a cada
 * PackagePlan/origen de la allocation, nunca una combinación ad-hoc.
 */
const ShippingSelection = model.define("shipping_selection", {
  id: model.id().primaryKey(),
  cart_id: model.text(),
  allocation_snapshot_id: model.text(),
  service_level: model.text(),
  total_customer_amount: model.bigNumber().nullable(),
  total_provider_amount: model.bigNumber().nullable(),
  currency_code: model.text(),
  status: model.enum(["active", "selected", "superseded", "expired"]).default("active"),
  expires_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["cart_id", "status"],
  },
])

export default ShippingSelection
