import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { resolveCommerceAuditEmitter, type CommerceAuditEventType } from "../../commerce-audit/events"
import { SUPPLIER_FULFILLMENT_MODULE } from "../index"
import type SupplierFulfillmentModuleService from "../service"
import { canTransition, type WarehouseShipmentStatus } from "../rules/state-machine"

/**
 * Helpers compartidos entre `process-order-fulfillment.ts` (el workflow
 * automático) y `manual-intervention.ts` (las operaciones controladas,
 * plan §16-§23) -- viven aparte para que ninguno de los dos importe del
 * otro (evita ciclos) y para que la guardia de transición/el audit trail
 * sean EXACTAMENTE los mismos sin importar qué camino escribió el estado.
 */

export async function resolveCartIdForOrder(
  container: { resolve: <T = unknown>(key: string) => T },
  orderId: string
): Promise<string | null> {
  const link = container.resolve<{ list: (filter: unknown, config: unknown) => Promise<unknown[]> }>(
    ContainerRegistrationKeys.LINK
  )
  const links = await link.list(
    { [Modules.ORDER]: { order_id: orderId }, [Modules.CART]: { cart_id: { $ne: null } } },
    {}
  )
  return links.length ? (links[0] as { cart_id: string }).cart_id : null
}

/**
 * Guardia real contra la máquina de estados explícita (rules/state-
 * machine.ts) -- nunca un chequeo ad-hoc por llamada, y nunca solo en el
 * camino automático: una operación MANUAL que intente una transición
 * fuera de tabla debe rechazarse exactamente igual (plan §19: "validar
 * transición").
 */
export function assertValidTransition(
  shipmentId: string,
  from: WarehouseShipmentStatus,
  to: WarehouseShipmentStatus
): void {
  if (!canTransition(from, to)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Transición de estado inválida en WarehouseShipment ${shipmentId}: ${from} -> ${to}`
    )
  }
}

/**
 * Emite a AMBOS lados del audit trail (plan §30/§23): el
 * `CommerceAuditEmitter` general (consistencia con el resto del
 * proyecto) y `WarehouseShipmentEvent` (tabla real y consultable por
 * `warehouse_shipment_id`, ver docblock del modelo). `actor` es
 * obligatorio para toda operación MANUAL (plan §19/§21/§23) -- el
 * camino automático lo deja `null` a propósito (nadie "actuó", fue el
 * workflow).
 */
export async function emitEvent(
  container: { resolve: <T = unknown>(key: string) => T },
  warehouseShipmentId: string,
  eventType: CommerceAuditEventType,
  details: Record<string, unknown> = {},
  actor: string | null = null
): Promise<void> {
  const auditEmitter = resolveCommerceAuditEmitter(container)
  const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
  const now = new Date()
  auditEmitter.emit({ eventType, correlationId: warehouseShipmentId, details, occurredAt: now })
  await fulfillmentService.createWarehouseShipmentEvents({
    warehouse_shipment_id: warehouseShipmentId,
    event_type: eventType,
    actor,
    occurred_at: now,
    details,
  })
}
