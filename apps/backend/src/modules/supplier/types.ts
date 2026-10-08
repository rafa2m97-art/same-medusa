/**
 * Contratos de proveedor del dominio SAME. El dominio solo conoce estas
 * formas normalizadas — nunca la forma cruda de la respuesta de un
 * proveedor concreto (Exel, o cualquier otro a futuro). La traducción
 * cruda→normalizada vive enteramente en cada adaptador concreto, en
 * src/integrations/suppliers/<proveedor>/.
 *
 * Diseñado confrontando estos contratos contra la documentación OFICIAL
 * real de la API de Exel del Norte
 * (investigation-78767/exel-api-docs.json, 22 endpoints documentados) y el
 * código real de class-msl-exel-api.php — no son tipos inventados. Ver
 * HALLAZGOS en el reporte de Etapa 2 para el detalle campo por campo.
 *
 * Deliberadamente NO incluido todavía (pertenece a la Etapa 3 —
 * Reconciliation/Quarantine, no a esta Etapa 2 de dominio de proveedor):
 * classifyConflicts() / APPLY-QUARANTINE.
 */

// ---- DTOs normalizados de catálogo/inventario ----

export interface NormalizedSupplierProduct {
  supplierSku: string
  supplierInternalRef?: string
  name: string
  description?: string
  brandName?: string
  categoryName?: string
  images: string[]
  weightKg?: number
  dimensionsCm?: { length: number; width: number; height: number }
  costPrice: number
  currency: string
}

export interface SupplierWarehouseDescriptor {
  externalCode: string
  name: string
  address?: string
  city?: string
  state?: string
  country?: string
  latitude?: number
  longitude?: number
}

export interface NormalizedWarehouseStock {
  warehouseExternalCode: string
  supplierSku: string
  quantity: number
}

export interface NormalizedCatalogTotal {
  supplierSku: string
  totalQuantity: number
}

export interface AllocationLineToConfirm {
  warehouseExternalCode: string
  supplierSku: string
  quantity: number
}

/**
 * Etapa 7 (plan §18): distingue explícitamente "el proveedor respondió
 * que no hay stock" de "la API del proveedor no respondió en
 * absoluto" -- son estados DIFERENTES con retryability distinta (ver
 * checkout-guards/rules/taxonomy.ts). `confirmed` se conserva por
 * compatibilidad (equivalente a `status === "CONFIRMED"`); el código
 * nuevo debe leer `status`, nunca inferirlo de `confirmed` solo.
 */
export type LiveConfirmationStatus = "CONFIRMED" | "REJECTED" | "UNAVAILABLE" | "TIMEOUT" | "ERROR"

export interface LiveConfirmationResult {
  confirmed: boolean
  status: LiveConfirmationStatus
  reason?: string
  confirmedQuantityByWarehouse?: Record<string, number>
}

export interface RetryPolicy {
  maxAttempts: number
  backoffMs: number[]
  nonRetryableErrorCodes: string[]
}

// ---- DTOs normalizados de fulfillment (pedido a proveedor) ----
//
// REGLA CONFIRMADA (código real, send_warehouse_order): si una Order SAME
// se reparte entre varios almacenes, el proveedor recibe UN pedido
// INDEPENDIENTE por almacén — nunca un solo pedido con múltiples almacenes.
// Por eso SupplierOrderRequest representa el fulfillment de UN SOLO
// almacén, nunca una lista de almacenes. El flujo real es:
//
//   Order SAME -> AllocationSnapshot -> WarehouseShipment (1 por almacén)
//     -> SupplierOrderRequest (1 por WarehouseShipment) -> adapter.order.submitFulfillmentOrder()
//
// Esto es intencional incluso aunque WarehouseShipment como módulo
// completo (con su propia máquina de estados) pertenezca a una etapa
// posterior — el contrato de esta etapa ya debe ser compatible con esa
// regla, no "genérico a punta de aceptar cualquier cosa".

export interface SupplierOrderRequestLine {
  supplierSku: string
  quantity: number
}

/** Dirección/contacto de destino, normalizada — no los nombres de campo de Exel. */
export interface SupplierOrderDestination {
  contactName: string
  email?: string
  phone?: string
  street: string
  exteriorNumber: string
  interiorNumber?: string
  neighborhood: string
  postalCode: string
  city?: string
  state?: string
  country: string
  notes?: string
}

/**
 * La guía de envío ya comprada por SAME (vía Envia) que se entrega al
 * proveedor como prueba de que el transporte ya está resuelto — el
 * proveedor nunca gestiona el transporte él mismo en el flujo de SAME.
 */
export interface SupplierOrderShippingLabel {
  trackingNumber: string
  carrierName: string
  labelBase64?: string
  labelFormat?: "PDF" | "ZPL"
}

/**
 * Una solicitud de fulfillment para UN proveedor en UN almacén concreto —
 * nunca para varios almacenes a la vez. `warehouseShipmentId` es el ancla
 * de idempotencia real (ver nota de idempotencia abajo): se genera una
 * sola vez por (Order, SupplierWarehouse) y nunca se regenera en un
 * reintento, así que un adaptador puede usarlo para preguntarse "¿ya
 * envié esto?" antes de volver a llamar al proveedor, sin depender de que
 * el proveedor soporte una idempotency key él mismo (Exel no la soporta —
 * no existe ese parámetro en su API documentada).
 */
export interface SupplierOrderRequest {
  supplierId: string
  supplierWarehouseId: string
  sameOrderId: string
  warehouseShipmentId: string
  referenceId: string
  lines: SupplierOrderRequestLine[]
  destination: SupplierOrderDestination
  shipping?: SupplierOrderShippingLabel
  comment?: string
  externalReferences?: Record<string, string>
}

export interface SupplierOrderResult {
  success: boolean
  supplierOrderId?: string
  rawStatus?: string
  error?: string
  retryable?: boolean
  /**
   * Etapa 9 (plan §10): ¿pudo el proveedor haber recibido/creado el
   * pedido aunque esta respuesta sea un error? Exel no tiene idempotency
   * key nativa -- un timeout de red (fetch() nunca recibe respuesta) es
   * AMBIGUO (el pedido pudo llegar), mientras que un HTTP de error con
   * cuerpo parseado (parseExelCreateOrderResponse) NO lo es (Exel
   * respondió, sabemos qué dijo). Default `false`/`undefined` -- solo
   * el caller que atrapa una excepción cruda (nunca un resultado
   * tipado) debe asumir `true`.
   */
  sideEffectMayHaveOccurred?: boolean
}

// ---- Contratos por capacidad ----
// Divididos a propósito: un proveedor futuro podría no soportar todas (ej.
// solo EDI/correo para órdenes, sin API). Cuatro interfaces chicas, no una
// jerarquía profunda.

export interface SupplierCatalogAdapter {
  fetchFullCatalog(): Promise<NormalizedSupplierProduct[]>
}

export interface SupplierInventoryAdapter {
  listWarehouses(): Promise<SupplierWarehouseDescriptor[]>
  fetchStockByWarehouse(): Promise<NormalizedWarehouseStock[]>
  fetchCatalogTotals(): Promise<NormalizedCatalogTotal[]>
  confirmAllocationLive(
    allocation: AllocationLineToConfirm[]
  ): Promise<LiveConfirmationResult>
}

export interface SupplierPricingAdapter {
  computePublicPrice(costPrice: number, currency: string): number
}

/**
 * `getRetryPolicy()` (Etapa 9): reubicado desde `SupplierInventoryAdapter`
 * -- verificado por SSH 2026-10-06 contra `handle_send_failure()`/
 * `send_warehouse_order()` reales (class-msl-exel-api.php) que la
 * política real de 3 intentos/backoff 5-15-60min gobierna ESPECÍFICAMENTE
 * el reintento de `POST /pedido` (envío al proveedor), nunca la
 * confirmación de stock en vivo -- la ubicación en Etapa 2 fue una
 * atribución equivocada (nunca se había llegado a usar el método en
 * ningún workflow real hasta ahora, así que mover el método no rompe
 * nada existente).
 */
export interface SupplierOrderAdapter {
  submitFulfillmentOrder(
    req: SupplierOrderRequest
  ): Promise<SupplierOrderResult>
  getRetryPolicy(): RetryPolicy
}

/**
 * Contrato compuesto. Un adaptador concreto (ExelAdapter, y a futuro
 * CVAAdapter/CTAdapter/IngramAdapter/etc.) implementa las cuatro
 * capacidades y se identifica con `supplierCode`, que debe coincidir con
 * el `code` de la fila `Supplier` correspondiente.
 */
export interface SupplierAdapter {
  readonly supplierCode: string
  catalog: SupplierCatalogAdapter
  inventory: SupplierInventoryAdapter
  pricing: SupplierPricingAdapter
  order: SupplierOrderAdapter
}
