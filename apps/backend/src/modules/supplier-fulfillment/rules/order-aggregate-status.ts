import type { WarehouseShipmentStatus } from "./state-machine"

/**
 * Estado operativo AGREGADO de una Order, derivado SIEMPRE de sus
 * WarehouseShipment -- nunca una segunda fuente de verdad persistida
 * (plan §7/§36: "no guardar dos fuentes de verdad si puede derivarse").
 * Pura, sin I/O: el workflow solo lee los `status` de los shipments y
 * llama esto para mostrar/loggear el agregado.
 */
export type OrderFulfillmentStatus =
  | "PREPARING"
  | "PROCESSING"
  | "PARTIALLY_SHIPPED"
  | "SHIPPED"
  | "DELIVERED"
  | "REQUIRES_ATTENTION"
  | "CANCELLED"

export function deriveOrderFulfillmentStatus(
  shipmentStatuses: WarehouseShipmentStatus[]
): OrderFulfillmentStatus {
  if (shipmentStatuses.length === 0) return "PREPARING"

  // Cualquier shipment en revisión manual domina el agregado -- un
  // admin necesita mirar la Order completa, sin importar qué tan
  // avanzados estén los demás orígenes.
  if (shipmentStatuses.some((s) => s === "REQUIRES_MANUAL_REVIEW")) return "REQUIRES_ATTENTION"

  if (shipmentStatuses.every((s) => s === "CANCELLED")) return "CANCELLED"

  const active = shipmentStatuses.filter((s) => s !== "CANCELLED")
  if (active.length === 0) return "CANCELLED"

  if (active.every((s) => s === "DELIVERED")) return "DELIVERED"
  if (active.every((s) => s === "SHIPPED" || s === "DELIVERED")) return "SHIPPED"
  if (active.some((s) => s === "SHIPPED" || s === "DELIVERED")) return "PARTIALLY_SHIPPED"
  if (active.every((s) => s === "SUPPLIER_ACCEPTED" || s === "PROCESSING")) return "PROCESSING"

  // Todo lo demás (pendiente, comprando/esperando guía, esperando
  // envío al proveedor) es, para el cliente/admin, "seguimos
  // preparando tu pedido" -- incluye explícitamente el caso real del
  // plan §29 ("MY label ready, MX label pending" sigue siendo PREPARING,
  // nunca se adelanta a PROCESSING solo porque un origen ya tiene guía).
  return "PREPARING"
}
