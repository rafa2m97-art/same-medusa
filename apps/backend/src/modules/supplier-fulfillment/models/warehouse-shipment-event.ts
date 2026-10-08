import { model } from "@medusajs/framework/utils"

/**
 * Historial operacional real de UN WarehouseShipment (plan §30) —
 * tabla PROPIA, no solo `commerce-audit`. Justificación explícita: al
 * revisar `commerce-audit/events.ts` (Etapa 3), ese módulo TODAVÍA no
 * es una tabla real persistida — es una interfaz +
 * `InMemoryCommerceAuditEmitter` a propósito, "preparación... no se
 * construye en esta etapa" — no sirve como fuente de verdad para
 * "reconstruir: created, label purchase started, label purchased,
 * supplier submission started, supplier accepted, retry, manual
 * override" que esta etapa SÍ necesita poder consultar de verdad. Por
 * eso: se sigue emitiendo por `CommerceAuditEmitter` (mismos nombres de
 * evento, consistencia con el resto del proyecto) Y ADEMÁS se persiste
 * aquí, en una tabla real y consultable por `warehouse_shipment_id`.
 *
 * `details` nunca incluye el PDF/base64 de la guía (plan §17/§43) --
 * solo referencias (`label_reference`, no el archivo).
 */
const WarehouseShipmentEvent = model.define("warehouse_shipment_event", {
  id: model.id().primaryKey(),
  warehouse_shipment_id: model.text(),
  event_type: model.text(),
  actor: model.text().nullable(),
  occurred_at: model.dateTime(),
  details: model.json().nullable(),
}).indexes([
  {
    on: ["warehouse_shipment_id", "occurred_at"],
  },
])

export default WarehouseShipmentEvent
