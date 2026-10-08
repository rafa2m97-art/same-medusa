import { model } from "@medusajs/framework/utils"

/**
 * Límites de peso/dimensión por transportista (plan §15). Generaliza, con
 * evidencia real (SSH 2026-10-05, `same_get_carrier_limits()` en
 * msl-exel-bridge/includes/helpers.php), la tabla hoy hardcodeada en
 * código PHP a filas editables, cada una con su PROCEDENCIA explícita —
 * exactamente lo pedido: nunca un magic number sin origen.
 *
 * `source`:
 *   documented           -> catálogo público del transportista (ej. ficha
 *                           técnica de FedEx/UPS), nunca probado en vivo.
 *   empirically_verified -> probado EN VIVO contra Envia.com (POST real a
 *                           /ship/rate/, sin crear guía) y el carrier
 *                           cotizó sin rechazo. Dos casos reales ya
 *                           existen y se preservan tal cual (ver seed):
 *                             - DHL: verificado 2026-08-28, ruta San
 *                               Nicolás de los Garza NL -> Guadalajara
 *                               JAL, hasta 500kg/100x100x80cm (el límite
 *                               documentado de 70kg excluía productos
 *                               reales del catálogo, ej. UPS APC Slot
 *                               8000VA de 126.55kg).
 *                             - Paquetexpress: verificado 2026-08-28 (2a
 *                               pasada, tras arreglar la colonia de
 *                               origen faltante), misma ruta, hasta
 *                               300kg/100x80x60cm, ~6-7x más barato que
 *                               DHL en esa ruta.
 *
 * `carrier_code = "default"` (service_code null) es la política
 * CONSERVADORA que usa `planPackages()` para decidir cuándo dividir un
 * plan en varios paquetes — nunca los límites reales de un carrier
 * específico, que solo se usan para decidir si vale la pena intentar
 * cotizar un paquete ya armado (ver rules/unshippable.ts). Mismo
 * principio que el código real: `same_validate_parcel()` sin límites
 * explícitos cae al límite "default", nunca a uno de carrier.
 */
const CarrierLimit = model.define("carrier_limit", {
  id: model.id().primaryKey(),
  carrier_code: model.text(),
  service_code: model.text().nullable(),
  max_weight_kg: model.float(),
  max_length_cm: model.float(),
  max_width_cm: model.float(),
  max_height_cm: model.float(),
  max_girth_cm: model.float(),
  source: model.enum(["documented", "empirically_verified"]),
  verified_at: model.dateTime().nullable(),
  environment: model.enum(["sandbox", "production"]).nullable(),
  notes: model.text().nullable(),
  status: model.enum(["active", "inactive"]).default("active"),
}).indexes([
  {
    on: ["carrier_code", "status"],
  },
])

export default CarrierLimit
