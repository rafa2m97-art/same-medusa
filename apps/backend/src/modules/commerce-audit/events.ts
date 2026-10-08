/**
 * Preparación para commerce-audit (plan §8) — el módulo `commerce-audit/`
 * todavía no existe (no se construye en esta etapa, para no romper el
 * alcance de Etapa 3 pedido explícitamente). Lo que SÍ se deja listo: la
 * interfaz de eventos de NEGOCIO que la reconciliación debe emitir, y un
 * emisor en memoria para que los tests puedan verificar qué se habría
 * auditado sin depender de que el módulo real exista.
 *
 * Conexión futura (cuando se construya commerce-audit/): se reemplaza
 * `InMemoryCommerceAuditEmitter` por una implementación que escriba
 * `CommerceAuditEvent` real, y se inyecta donde hoy se inyecta el emitter
 * en memoria — ningún código de reconciliación necesita cambiar porque ya
 * depende solo de `CommerceAuditEmitter` (la interfaz), nunca de la
 * implementación.
 *
 * No duplica logs técnicos — solo los eventos de negocio pedidos.
 *
 * Inyección por CONTENEDOR, no por input de workflow (lección real de
 * Etapa 4): el motor de Workflows de Medusa serializa el input/output de
 * cada step (persistencia de la transacción distribuida) — una instancia
 * de clase pasada como dato de workflow pierde sus métodos al pasar por
 * ese serializador (`emitter.emit` deja de ser una función). La única
 * forma correcta de inyectar un servicio con comportamiento es resolverlo
 * del contenedor DI dentro del propio step. `COMMERCE_AUDIT_EMITTER` es la
 * registration key que los steps de Inventory usan; si nada la registró
 * (como en producción hoy, sin commerce-audit real todavía), caen a
 * `NoopCommerceAuditEmitter`.
 */

export type CommerceAuditEventType =
  | "SUPPLIER_SYNC_STARTED"
  | "SUPPLIER_SYNC_COMPLETED"
  | "STOCK_CONFLICT_DETECTED"
  | "PRODUCT_QUARANTINED"
  | "PRODUCT_QUARANTINE_CLEARED"
  // Etapa 4 (Inventory) — pedidos explícitamente por el usuario, §20.
  | "INVENTORY_APPLY_STARTED"
  | "INVENTORY_LEVEL_CHANGED"
  | "INVENTORY_APPLY_COMPLETED"
  | "INVENTORY_APPLY_REJECTED_STALE"
  // Etapa 5 (Pricing) — pedidos explícitamente por el usuario, §17.
  | "SUPPLIER_COST_CHANGED"
  | "PUBLIC_PRICE_CALCULATED"
  | "PUBLIC_PRICE_UPDATED"
  | "PRICE_CHANGE_REJECTED"
  | "PRICE_CHANGE_REQUIRES_REVIEW"
  // Etapa 5.1 (Pricing Source Selection) — pedidos explícitamente por el usuario, §17.
  | "PRICING_SOURCE_SELECTED"
  | "PRICING_SOURCE_UNAVAILABLE"
  | "PRICING_SOURCE_CHANGED"
  // Etapa 6 (Routing/Sourcing) — pedidos explícitamente por el usuario.
  | "ROUTING_STARTED"
  | "ROUTING_COMPLETED"
  | "ROUTING_UNFULFILLABLE"
  | "ALLOCATION_CREATED"
  | "ALLOCATION_SUPERSEDED"
  | "ALLOCATION_EXPIRED"
  // Etapa 7 (Checkout Guards) — pedidos explícitamente por el usuario, §38.
  | "CHECKOUT_VALIDATION_STARTED"
  | "PRICE_GUARD_FAILED"
  | "RESERVATION_CREATED"
  | "RESERVATION_RELEASED"
  | "LIVE_STOCK_CONFIRMED"
  | "LIVE_STOCK_REJECTED"
  | "SUPPLIER_CONFIRMATION_UNAVAILABLE"
  | "ADDRESS_GUARD_FAILED"
  | "SHIPPING_QUOTE_INVALID"
  | "CHECKOUT_READY_FOR_PAYMENT"
  | "CHECKOUT_READINESS_INVALIDATED"
  // Etapa 8 (Package Planning + Envia) — pedidos explícitamente por el usuario, §50.
  | "PACKAGE_PLAN_CREATED"
  | "PACKAGE_PLAN_SUPERSEDED"
  | "SHIPPING_QUOTE_REQUESTED"
  | "SHIPPING_QUOTE_RECEIVED"
  | "SHIPPING_QUOTE_FAILED"
  | "SHIPPING_QUOTE_SELECTED"
  | "SHIPPING_QUOTE_EXPIRED"
  // Etapa 9 (WarehouseShipment / Supplier Fulfillment) — pedidos explícitamente por el usuario, §43.
  | "WAREHOUSE_SHIPMENT_CREATED"
  | "LABEL_PURCHASE_STARTED"
  | "LABEL_PURCHASED"
  | "LABEL_PURCHASE_FAILED"
  | "ALL_LABELS_READY"
  | "SUPPLIER_ORDER_SUBMISSION_STARTED"
  | "SUPPLIER_ORDER_ACCEPTED"
  | "SUPPLIER_ORDER_FAILED"
  | "WAREHOUSE_SHIPMENT_RETRY_SCHEDULED"
  | "WAREHOUSE_SHIPMENT_MANUAL_REVIEW"
  | "WAREHOUSE_SHIPMENT_CANCELLED"

export interface CommerceAuditEvent {
  eventType: CommerceAuditEventType
  correlationId: string
  supplierId?: string
  syncRunId?: string
  supplierProductMappingId?: string
  /** Snapshot ligero, nunca el objeto completo. */
  details?: Record<string, unknown>
  occurredAt: Date
}

export interface CommerceAuditEmitter {
  emit(event: CommerceAuditEvent): void
}

export class InMemoryCommerceAuditEmitter implements CommerceAuditEmitter {
  readonly events: CommerceAuditEvent[] = []

  emit(event: CommerceAuditEvent): void {
    this.events.push(event)
  }
}

export class NoopCommerceAuditEmitter implements CommerceAuditEmitter {
  emit(): void {}
}

export const COMMERCE_AUDIT_EMITTER = "commerceAuditEmitter"

export function resolveCommerceAuditEmitter(container: {
  resolve: (key: string) => unknown
}): CommerceAuditEmitter {
  try {
    return container.resolve(COMMERCE_AUDIT_EMITTER) as CommerceAuditEmitter
  } catch {
    return new NoopCommerceAuditEmitter()
  }
}
