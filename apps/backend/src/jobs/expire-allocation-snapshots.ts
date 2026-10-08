import type { MedusaContainer } from "@medusajs/framework/types"
import { WAREHOUSE_ROUTING_MODULE } from "../modules/warehouse-routing"
import type WarehouseRoutingModuleService from "../modules/warehouse-routing/service"
import { resolveCommerceAuditEmitter } from "../modules/commerce-audit/events"

/**
 * Cierra el ciclo de vida de AllocationSnapshot (Etapa 6, plan
 * TTL/lifecycle): una ACTIVE cuyo `expires_at` ya pasó sin que el
 * carrito la haya usado para completar la compra (Etapa 7+, todavía no
 * implementado) deja de ser válida — nunca se borra (sigue como
 * historial), solo transiciona a `expired`. Nunca toca una snapshot que
 * YA está en otro estado (superseded/consumed/invalidated/expired) —
 * esta es la única puerta de entrada al estado `expired`.
 */
export default async function expireAllocationSnapshotsJob(container: MedusaContainer) {
  const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
  const auditEmitter = resolveCommerceAuditEmitter(container)

  const now = new Date()
  const expired = await routingService.listAllocationSnapshots({
    status: "active",
    expires_at: { $ne: null, $lt: now },
  })

  if (expired.length === 0) return

  await routingService.updateAllocationSnapshots(
    expired.map((snapshot) => ({ id: snapshot.id, status: "expired" as const }))
  )

  for (const snapshot of expired) {
    auditEmitter.emit({
      eventType: "ALLOCATION_EXPIRED",
      correlationId: snapshot.cart_id,
      details: { snapshotId: snapshot.id },
      occurredAt: now,
    })
  }
}

export const config = {
  name: "expire-allocation-snapshots",
  schedule: "*/5 * * * *",
}
