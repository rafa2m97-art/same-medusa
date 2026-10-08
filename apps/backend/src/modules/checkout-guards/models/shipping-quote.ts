import { model } from "@medusajs/framework/utils"

/**
 * Tarifa de envío para UN carrito + UNA allocation concreta (plan §25).
 *
 * Decisión: NO se reutiliza `ShippingOption` nativo de Medusa. Revisado
 * antes de construir esto (plan §25, "primero revisa las capacidades
 * nativas"): `ShippingOption`/`ServiceZone` modelan tarifas
 * CONFIGURADAS por la tienda (reglas fijas o calculadas por zona) —
 * nunca una cotización dinámica de un carrier externo con expiración y
 * atada a una AllocationSnapshot concreta. Forzar eso en
 * `ShippingOption` habría significado crear/destruir opciones por
 * carrito, un abuso del modelo nativo. `ShippingQuote` es deliberadamente
 * pequeño y vive aparte; cuando Etapa 8 integre Envia de verdad, esta
 * tabla es donde aterriza cada cotización en vivo.
 *
 * `allocation_snapshot_id` (plan §26): la tarifa corresponde a UNA
 * decisión de Routing concreta -- un cambio de allocation (de un solo
 * origen a split, u otro almacén) invalida la quote aunque el destino
 * no haya cambiado, porque el plan de empaque real (Etapa 8) depende
 * de qué/cuántos orígenes hay que cotizar.
 *
 * `is_free_shipping` (plan §27): flag EXPLÍCITO y nunca inferido. $0
 * solo es válido cuando esto es `true`; cualquier otro camino hacia
 * amount<=0 (faltante/inválido) se trata como "no hay tarifa" (ver
 * rules/shipping-quote-guard.ts) -- mismo comportamiento real
 * confirmado en Envia (devuelve CERO opciones, nunca una de $0, cuando
 * los datos de entrada están incompletos).
 *
 * Extendido en Etapa 8 (plan §17: "reutilizarla, no crear otra entidad
 * duplicada") — nunca se renombró `amount` para no romper el contrato
 * ya probado de Etapa 7 (sigue siendo lo que el CLIENTE paga):
 *
 *   - `package_plan_id`: UNA quote corresponde a UN PackagePlan concreto
 *     (un origen) — nullable porque los fixtures de Etapa 7 (sin
 *     Package Planning todavía) crean quotes sin él; el workflow real
 *     de Etapa 8 siempre lo rellena.
 *   - `carrier_code`/`service_code`: identificadores NORMALIZADOS
 *     (nunca el string visual) — necesarios para comprar la guía con
 *     EXACTAMENTE el mismo servicio cotizado (plan §21).
 *   - `provider_amount`: lo que Envia le cobra a SAME -- DISTINTO de
 *     `amount` (lo que el cliente paga). Hoy pueden coincidir, pero
 *     nunca se acoplan (plan §31/§32: una futura promoción de envío
 *     gratis pone `amount=0` sin tocar `provider_amount`).
 *   - `estimated_delivery_days`: ETA preservada por origen (plan §49) --
 *     nunca agregada aquí; la agregación (`max` entre orígenes) es
 *     responsabilidad de quien lea varias quotes de una misma
 *     ShippingSelection.
 *   - `shipping_selection_id`: a qué opción completa del carrito
 *     pertenece esta quote (plan §20) -- ver ShippingSelection.
 */
const ShippingQuote = model.define("shipping_quote", {
  id: model.id().primaryKey(),
  cart_id: model.text(),
  allocation_snapshot_id: model.text(),
  package_plan_id: model.text().nullable(),
  shipping_selection_id: model.text().nullable(),
  carrier_name: model.text(),
  carrier_code: model.text().nullable(),
  service_code: model.text().nullable(),
  service_level: model.text().nullable(),
  amount: model.bigNumber().nullable(),
  provider_amount: model.bigNumber().nullable(),
  currency_code: model.text(),
  is_free_shipping: model.boolean().default(false),
  estimated_delivery_days: model.number().nullable(),
  quote_reference: model.text().nullable(),
  status: model.enum(["active", "expired", "consumed"]).default("active"),
  expires_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["cart_id", "status"],
  },
  {
    on: ["allocation_snapshot_id"],
  },
  {
    on: ["shipping_selection_id"],
  },
])

export default ShippingQuote
