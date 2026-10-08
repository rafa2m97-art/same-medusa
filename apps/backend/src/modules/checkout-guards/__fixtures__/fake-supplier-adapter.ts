import type {
  AllocationLineToConfirm,
  LiveConfirmationResult,
  NormalizedCatalogTotal,
  NormalizedSupplierProduct,
  NormalizedWarehouseStock,
  RetryPolicy,
  SupplierAdapter,
  SupplierCatalogAdapter,
  SupplierInventoryAdapter,
  SupplierOrderAdapter,
  SupplierOrderRequest,
  SupplierOrderResult,
  SupplierPricingAdapter,
  SupplierWarehouseDescriptor,
} from "../../supplier/types"

/**
 * Doble de pruebas GENÉRICO para `SupplierAdapter` (plan §16: "usar
 * FakeSupplierAdapter. No crear SyscomAdapter real."). No representa a
 * ningún proveedor concreto -- es puramente control remoto de
 * comportamiento para los tests de Checkout Guards (confirmación en
 * vivo multi-proveedor, timeouts, errores), igual que `Syscom` se usó
 * en Etapas 5/6 como dato inerte, nunca como integración real.
 */
export type FakeLiveConfirmationBehavior =
  | { mode: "confirm" }
  | { mode: "reject"; reason?: string }
  | { mode: "unavailable"; reason?: string }
  | { mode: "timeout" }
  | { mode: "error"; reason?: string }

/**
 * Etapa 9: controla `order.submitFulfillmentOrder()` para probar
 * retry/validación/ambigüedad sin depender de Exel real.
 *   success     -> acepta, devuelve una referencia estable.
 *   validation  -> rechazo NO retryable (dato inválido -- nunca side effect,
 *                  equivalente a que Exel SÍ respondió con un rechazo de negocio).
 *   timeout     -> devuelve AMBIGUOUS (`sideEffectMayHaveOccurred: true`,
 *                  `retryable: false`) -- simula que `fetch()` nunca recibió
 *                  respuesta (igual que el adapter real de Exel: un timeout de
 *                  red es el único caso real donde no sabemos si el pedido llegó).
 *   serverError -> rechazo retryable SIN ambigüedad (Exel sí respondió con un
 *                  HTTP de error parseable -- sabemos qué dijo, solo falló).
 *   throw       -> lanza una excepción cruda (no un SupplierOrderResult) --
 *                  para probar que el WORKFLOW caller, no el adapter, asume
 *                  ambigüedad por defecto ante cualquier excepción inesperada.
 */
export type FakeOrderSubmissionBehavior =
  | { mode: "success"; supplierOrderId?: string }
  | { mode: "validation"; reason?: string }
  | { mode: "timeout" }
  | { mode: "serverError"; reason?: string }
  | { mode: "throw"; message?: string }

export class FakeSupplierAdapter implements SupplierAdapter {
  readonly supplierCode: string
  catalog: SupplierCatalogAdapter
  inventory: SupplierInventoryAdapter
  pricing: SupplierPricingAdapter
  order: SupplierOrderAdapter

  private behavior: FakeLiveConfirmationBehavior = { mode: "confirm" }
  private orderBehavior: FakeOrderSubmissionBehavior = { mode: "success" }
  /**
   * Un `FakeSupplierAdapter` representa UN proveedor con VARIOS almacenes
   * (igual que Exel real: un solo adapter_key, múltiples SupplierWarehouse)
   * -- por eso el comportamiento de `submitFulfillmentOrder` se puede
   * sobreescribir POR almacén (clave = `warehouseExternalCode`, plan Etapa
   * 9 §3/§6: "multi-origin independence"), nunca solo globalmente. Un
   * origen sin override explícito usa `orderBehavior` (el default).
   */
  private orderBehaviorByWarehouseCode = new Map<string, FakeOrderSubmissionBehavior>()
  private submitFulfillmentOrderCallsByShipmentId = new Map<string, number>()
  /** Plan Etapa 9 §35: permite a los tests verificar EXACTAMENTE qué se envió por origen (líneas/clave de almacén), nunca solo el resultado final. */
  public submitFulfillmentOrderRequests: SupplierOrderRequest[] = []

  constructor(supplierCode: string) {
    this.supplierCode = supplierCode
    const self = this

    this.catalog = {
      async fetchFullCatalog(): Promise<NormalizedSupplierProduct[]> {
        return []
      },
    }

    this.inventory = {
      async listWarehouses(): Promise<SupplierWarehouseDescriptor[]> {
        return []
      },
      async fetchStockByWarehouse(): Promise<NormalizedWarehouseStock[]> {
        return []
      },
      async fetchCatalogTotals(): Promise<NormalizedCatalogTotal[]> {
        return []
      },
      async confirmAllocationLive(_allocation: AllocationLineToConfirm[]): Promise<LiveConfirmationResult> {
        const behavior = self.behavior
        switch (behavior.mode) {
          case "confirm":
            return { confirmed: true, status: "CONFIRMED" }
          case "reject":
            return { confirmed: false, status: "REJECTED", reason: behavior.reason ?? "sin stock" }
          case "unavailable":
            return { confirmed: false, status: "UNAVAILABLE", reason: behavior.reason ?? "no disponible" }
          case "timeout":
            throw new Error("FAKE_TIMEOUT")
          case "error":
            throw new Error(behavior.reason ?? "FAKE_ERROR")
        }
      },
    }

    this.pricing = {
      computePublicPrice(costPrice: number): number {
        return costPrice
      },
    }

    this.order = {
      async submitFulfillmentOrder(req: SupplierOrderRequest): Promise<SupplierOrderResult> {
        self.submitFulfillmentOrderRequests.push(req)
        self.submitFulfillmentOrderCallsByShipmentId.set(
          req.warehouseShipmentId,
          (self.submitFulfillmentOrderCallsByShipmentId.get(req.warehouseShipmentId) ?? 0) + 1
        )
        const behavior =
          self.orderBehaviorByWarehouseCode.get(req.externalReferences?.warehouseExternalCode ?? "") ??
          self.orderBehavior
        switch (behavior.mode) {
          case "success":
            return { success: true, supplierOrderId: behavior.supplierOrderId ?? "fake-order" }
          case "validation":
            return { success: false, error: behavior.reason ?? "dato inválido", retryable: false, sideEffectMayHaveOccurred: false }
          case "timeout":
            return { success: false, error: "FAKE_ORDER_TIMEOUT", retryable: false, sideEffectMayHaveOccurred: true }
          case "serverError":
            return { success: false, error: behavior.reason ?? "FAKE_ORDER_SERVER_ERROR", retryable: true, sideEffectMayHaveOccurred: false }
          case "throw":
            throw new Error(behavior.message ?? "FAKE_ORDER_UNEXPECTED_THROW")
        }
      },
      getRetryPolicy(): RetryPolicy {
        return {
          maxAttempts: 3,
          backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
          nonRetryableErrorCodes: ["local_config_error"],
        }
      },
    }
  }

  setLiveConfirmationBehavior(behavior: FakeLiveConfirmationBehavior): void {
    this.behavior = behavior
  }

  setOrderSubmissionBehavior(behavior: FakeOrderSubmissionBehavior): void {
    this.orderBehavior = behavior
  }

  setOrderSubmissionBehaviorForWarehouse(externalCode: string, behavior: FakeOrderSubmissionBehavior): void {
    this.orderBehaviorByWarehouseCode.set(externalCode, behavior)
  }

  /** Plan Etapa 9 §29: afirmar EXACTAMENTE cuántas veces se llamó submitFulfillmentOrder para UN WarehouseShipment -- nunca solo el estado final. */
  getSubmitFulfillmentOrderCallCount(warehouseShipmentId: string): number {
    return this.submitFulfillmentOrderCallsByShipmentId.get(warehouseShipmentId) ?? 0
  }
}
