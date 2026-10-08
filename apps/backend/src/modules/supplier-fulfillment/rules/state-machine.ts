/**
 * Máquina de estados de `WarehouseShipment` (plan Etapa 9 §6/§7) — el
 * fulfillment operativo de UNA combinación Supplier+SupplierWarehouse
 * dentro de una Order. Nunca se mezcla con el estado agregado de Order
 * (ver rules/order-aggregate-status.ts, derivado de esto, nunca al revés).
 *
 * Distinciones explícitas pedidas (plan §6):
 *   - fallo comprando guía vs. fallo enviando al proveedor: dos familias
 *     de estados `LABEL_FAILED_*` / `SUPPLIER_FAILED_*`, nunca un solo
 *     "FAILED" genérico — así un reporte puede distinguir en qué mitad
 *     del flujo está atascado un shipment sin inspeccionar el error.
 *   - temporal vs. permanente: `*_RETRYABLE` puede reintentarse dentro
 *     de política; `*_FINAL` ya agotó la política y requiere revisión.
 *   - intervención manual: `REQUIRES_MANUAL_REVIEW` es el único estado
 *     que acepta una transición "libre" (vía override explícito
 *     auditado, nunca automática) hacia cualquier otro estado no
 *     terminal — ver workflows/manual-intervention.ts.
 *
 * Ambigüedad de side-effect (plan §45/§16): NO es un estado aparte --
 * es una RAZÓN (`manual_review_reason`) para llegar a
 * `REQUIRES_MANUAL_REVIEW`. Agregar un estado `AMBIGUOUS` por cada
 * familia habría duplicado la máquina sin necesidad; lo que de verdad
 * importa (¿puede el sistema reintentar solo, o alguien debe decidir?)
 * ya lo captura el hecho de caer en `REQUIRES_MANUAL_REVIEW` en vez de
 * en un `*_RETRYABLE`.
 */

export type WarehouseShipmentStatus =
  | "PENDING"
  | "READY_FOR_LABEL"
  | "LABEL_PURCHASING"
  | "LABEL_PURCHASED"
  | "LABEL_FAILED_RETRYABLE"
  | "LABEL_FAILED_FINAL"
  | "SUPPLIER_SUBMISSION_PENDING"
  | "SUPPLIER_SUBMITTING"
  | "SUPPLIER_ACCEPTED"
  | "SUPPLIER_FAILED_RETRYABLE"
  | "SUPPLIER_FAILED_FINAL"
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "REQUIRES_MANUAL_REVIEW"
  | "CANCELLED"

/**
 * Nunca se permite `CANCELLED` directo desde `LABEL_PURCHASING` ni
 * `SUPPLIER_SUBMITTING` (plan §47: una operación externa "en vuelo" no
 * puede fingir que nunca pasó) -- esos dos estados SIEMPRE resuelven
 * primero hacia uno de sus estados de salida reales
 * (PURCHASED, FAILED, o REQUIRES_MANUAL_REVIEW), y solo DESDE ahí se
 * puede cancelar (ver §33: cancelar después de label/supplier puede
 * requerir una cancelación real con carrier/proveedor, no un borrado).
 */
export const VALID_TRANSITIONS: Record<WarehouseShipmentStatus, WarehouseShipmentStatus[]> = {
  PENDING: ["READY_FOR_LABEL", "CANCELLED"],
  READY_FOR_LABEL: ["LABEL_PURCHASING", "CANCELLED"],
  LABEL_PURCHASING: ["LABEL_PURCHASED", "LABEL_FAILED_RETRYABLE", "LABEL_FAILED_FINAL", "REQUIRES_MANUAL_REVIEW"],
  // CANCELLED directo (plan Etapa 9 §22): ninguno de los dos estados
  // *_RETRYABLE/*_FINAL de LABEL implica que una guía real exista todavía
  // (la compra en sí falló limpiamente) -- cancelar aquí nunca finge
  // revertir un side effect externo, porque nunca hubo uno.
  LABEL_FAILED_RETRYABLE: ["LABEL_PURCHASING", "LABEL_FAILED_FINAL", "REQUIRES_MANUAL_REVIEW", "CANCELLED"],
  // READY_FOR_LABEL/CANCELLED directos (plan §17: retryLabelPurchase() /
  // §22: cancelación segura) -- mismo razonamiento: *_FINAL de LABEL
  // nunca tuvo side effect real, así que un operador puede desbloquearlo
  // o cerrarlo sin pasar por una reconciliación de ambigüedad (esa
  // reconciliación es exclusiva de REQUIRES_MANUAL_REVIEW, que sigue
  // siendo el único camino desde un estado verdaderamente AMBIGUOUS).
  LABEL_FAILED_FINAL: ["REQUIRES_MANUAL_REVIEW", "READY_FOR_LABEL", "CANCELLED"],
  LABEL_PURCHASED: ["SUPPLIER_SUBMISSION_PENDING", "CANCELLED"],
  SUPPLIER_SUBMISSION_PENDING: ["SUPPLIER_SUBMITTING", "CANCELLED"],
  SUPPLIER_SUBMITTING: [
    "SUPPLIER_ACCEPTED",
    "SUPPLIER_FAILED_RETRYABLE",
    "SUPPLIER_FAILED_FINAL",
    "REQUIRES_MANUAL_REVIEW",
  ],
  SUPPLIER_FAILED_RETRYABLE: ["SUPPLIER_SUBMITTING", "SUPPLIER_FAILED_FINAL", "REQUIRES_MANUAL_REVIEW"],
  // SUPPLIER_SUBMISSION_PENDING directo (plan §18: retrySupplierSubmission())
  // -- a diferencia del lado de LABEL, aquí SÍ hubo un side effect real
  // antes (la guía YA se compró, por construcción del barrier) pero la
  // falla de ENVÍO AL PROVEEDOR en sí fue limpia (no ambigua) -- un
  // operador puede conceder el reintento sin pasar por reconciliación
  // de ambigüedad, nunca sin pasar por el registro de auditoría.
  SUPPLIER_FAILED_FINAL: ["REQUIRES_MANUAL_REVIEW", "SUPPLIER_SUBMISSION_PENDING"],
  SUPPLIER_ACCEPTED: ["PROCESSING", "REQUIRES_MANUAL_REVIEW"],
  PROCESSING: ["SHIPPED", "REQUIRES_MANUAL_REVIEW"],
  SHIPPED: ["DELIVERED", "REQUIRES_MANUAL_REVIEW"],
  DELIVERED: [],
  // Salida libre SOLO vía override manual explícito y auditado -- nunca
  // una transición "automática" del workflow normal (plan §31/§32).
  // LABEL_PURCHASED/SUPPLIER_ACCEPTED (Etapa 9 §19/§20: attachExternalLabel()/
  // attachSupplierOrderReference()) -- recuperación manual de un side
  // effect AMBIGUO que un operador confirmó externamente que SÍ ocurrió.
  REQUIRES_MANUAL_REVIEW: [
    "READY_FOR_LABEL",
    "LABEL_PURCHASING",
    "LABEL_PURCHASED",
    "SUPPLIER_SUBMISSION_PENDING",
    "SUPPLIER_SUBMITTING",
    "SUPPLIER_ACCEPTED",
    "CANCELLED",
  ],
  CANCELLED: [],
}

export function canTransition(from: WarehouseShipmentStatus, to: WarehouseShipmentStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

/** Estados en los que un shipment ya tiene una guía real comprada -- usado por el barrier de "todas las guías listas" (plan §20/§21). */
const LABEL_READY_OR_BEYOND: WarehouseShipmentStatus[] = [
  "LABEL_PURCHASED",
  "SUPPLIER_SUBMISSION_PENDING",
  "SUPPLIER_SUBMITTING",
  "SUPPLIER_ACCEPTED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
]

export function hasLabelReadyOrBeyond(status: WarehouseShipmentStatus): boolean {
  return LABEL_READY_OR_BEYOND.includes(status)
}

const TERMINAL_STATUSES: WarehouseShipmentStatus[] = ["DELIVERED", "CANCELLED"]

export function isTerminal(status: WarehouseShipmentStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}
