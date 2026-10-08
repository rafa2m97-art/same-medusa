import { model } from "@medusajs/framework/utils"

/**
 * El fulfillment operativo de UNA combinación Supplier+SupplierWarehouse
 * dentro de UNA Order (plan §1/§3/§4) — nunca metadata de `Order`. Regla
 * confirmada real (SSH 2026-10-06, `class-msl-exel-api.php`): si una
 * Order se divide entre MY y MX, Exel recibe DOS `POST /pedido`
 * independientes, nunca uno multi-almacén — por eso la unidad real de
 * fulfillment siempre fue "por almacén", aunque el sistema actual lo
 * modele con metadata dispersa en vez de una entidad propia.
 *
 * Identidad idempotente (plan §4/§11): única fila por
 * (order_id, supplier_id, supplier_warehouse_id) — un retry de
 * `createWarehouseShipmentsForOrderWorkflow` encuentra la fila
 * existente y la reutiliza, nunca crea una segunda.
 *
 * `package_plan_id`/`shipping_selection_id`/`shipping_quote_id` +
 * `carrier_code`/`service_code` se COPIAN aquí (no se leen por
 * referencia) en el momento de creación — freeze real (plan §12/§13):
 * aunque Etapa 8 recalculara/superseder-a esas filas después, ESTE
 * shipment sigue cotizando/comprando exactamente lo que se congeló al
 * crearse. `carrier_code`/`service_code` especialmente nunca deben
 * leerse de otra tabla en el momento de comprar la guía.
 *
 * `label_reference` guarda una REFERENCIA (storage path/URL), nunca el
 * PDF base64 inline (plan §18) — ver rules/label-storage.ts para dónde
 * vive el archivo real.
 *
 * Contadores/último-error separados para label vs. supplier submission
 * (plan §6: "distinguir claramente fallo comprando guía de fallo
 * enviando pedido") — nunca un solo `attempt_count`/`last_error`
 * genérico que mezcle ambas fases.
 */
const WarehouseShipment = model.define("warehouse_shipment", {
  id: model.id().primaryKey(),
  order_id: model.text(),
  allocation_snapshot_id: model.text(),
  supplier_id: model.text(),
  supplier_warehouse_id: model.text(),
  stock_location_id: model.text().nullable(),
  package_plan_id: model.text(),
  shipping_selection_id: model.text(),
  shipping_quote_id: model.text(),
  carrier_code: model.text(),
  service_code: model.text().nullable(),

  status: model
    .enum([
      "PENDING",
      "READY_FOR_LABEL",
      "LABEL_PURCHASING",
      "LABEL_PURCHASED",
      "LABEL_FAILED_RETRYABLE",
      "LABEL_FAILED_FINAL",
      "SUPPLIER_SUBMISSION_PENDING",
      "SUPPLIER_SUBMITTING",
      "SUPPLIER_ACCEPTED",
      "SUPPLIER_FAILED_RETRYABLE",
      "SUPPLIER_FAILED_FINAL",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
      "REQUIRES_MANUAL_REVIEW",
      "CANCELLED",
    ])
    .default("PENDING"),

  tracking_number: model.text().nullable(),
  label_reference: model.text().nullable(),
  label_format: model.enum(["PDF", "ZPL"]).nullable(),
  provider_shipment_id: model.text().nullable(),
  provider_cost_amount: model.bigNumber().nullable(),

  supplier_order_reference: model.text().nullable(),
  supplier_order_status: model.text().nullable(),

  label_attempt_count: model.number().default(0),
  label_last_error_code: model.text().nullable(),
  label_last_error_message: model.text().nullable(),
  label_last_attempt_at: model.dateTime().nullable(),

  supplier_attempt_count: model.number().default(0),
  supplier_last_error_code: model.text().nullable(),
  supplier_last_error_message: model.text().nullable(),
  supplier_last_attempt_at: model.dateTime().nullable(),

  requires_manual_review: model.boolean().default(false),
  manual_review_reason: model.text().nullable(),
  cancelled_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["order_id", "supplier_id", "supplier_warehouse_id"],
    unique: true,
  },
  {
    on: ["order_id", "status"],
  },
])

export default WarehouseShipment
