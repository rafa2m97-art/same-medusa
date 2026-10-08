import type {
  PurchaseShippingLabelRequest,
  PurchaseShippingLabelResult,
  ShippingLabelErrorCode,
  ShippingLabelProvider,
} from "../types"

/**
 * Doble de pruebas para `ShippingLabelProvider` — equivalente a
 * `FakeShippingRateProvider` (Etapa 8). Nunca llama a Envia real;
 * guarda cada request recibido para que los tests puedan verificar
 * EXACTAMENTE qué se le pidió comprar (carrier/service/origin/
 * destination/paquetes, plan §13/§14/§51).
 */
export type FakeLabelPurchaseBehavior =
  | { mode: "success"; providerShipmentId?: string; trackingNumber?: string; providerCostAmount?: number }
  | { mode: "error"; errorCode: ShippingLabelErrorCode; errorMessage?: string; sideEffectMayHaveOccurred?: boolean; currentProviderAmount?: number }
  | { mode: "throw"; message?: string }

export class FakeShippingLabelProvider implements ShippingLabelProvider {
  readonly providerCode: string
  private behavior: FakeLabelPurchaseBehavior = { mode: "success" }
  /**
   * Un `FakeShippingLabelProvider` es UNA sola instancia resuelta por el
   * contenedor DI para TODA la Order -- compartida entre orígenes (igual
   * que el Envia real). Por eso el comportamiento se puede sobreescribir
   * POR shipment (`idempotencyKey`, plan Etapa 9 §5: "label retry
   * independiente"), nunca solo globalmente; un origen sin override usa
   * `behavior` (el default).
   */
  private behaviorByKey = new Map<string, FakeLabelPurchaseBehavior>()
  /**
   * Override por NOMBRE de origen (`request.origin.name`, que el
   * workflow real llena con `SAME ${warehouse.external_code}`) -- a
   * diferencia de `behaviorByKey`, este SÍ se puede configurar ANTES de
   * la primera corrida (el `WarehouseShipment.id`/`idempotencyKey` no
   * existe todavía en ese momento). Necesario para el barrier test
   * (plan §4: "MY label ok, MX label fail" en la MISMA corrida).
   */
  private behaviorByOriginName = new Map<string, FakeLabelPurchaseBehavior>()
  public requests: PurchaseShippingLabelRequest[] = []
  public callCount = 0

  constructor(providerCode = "fake-envia-label") {
    this.providerCode = providerCode
  }

  setBehavior(behavior: FakeLabelPurchaseBehavior): void {
    this.behavior = behavior
  }

  setBehaviorForKey(idempotencyKey: string, behavior: FakeLabelPurchaseBehavior): void {
    this.behaviorByKey.set(idempotencyKey, behavior)
  }

  setBehaviorForOrigin(originName: string, behavior: FakeLabelPurchaseBehavior): void {
    this.behaviorByOriginName.set(originName, behavior)
  }

  /** Plan Etapa 9 §29: afirmar EXACTAMENTE cuántas veces se llamó purchaseLabel para UN WarehouseShipment -- nunca solo el estado final. */
  callCountFor(idempotencyKey: string): number {
    return this.requests.filter((r) => r.idempotencyKey === idempotencyKey).length
  }

  async purchaseLabel(request: PurchaseShippingLabelRequest): Promise<PurchaseShippingLabelResult> {
    this.requests.push(request)
    this.callCount += 1
    const behavior =
      this.behaviorByKey.get(request.idempotencyKey) ??
      this.behaviorByOriginName.get(request.origin.name) ??
      this.behavior

    switch (behavior.mode) {
      case "success":
        return {
          status: "PURCHASED",
          providerShipmentId: behavior.providerShipmentId ?? `fake-shipment-${this.callCount}`,
          trackingNumber: behavior.trackingNumber ?? `FAKE-TRACK-${this.callCount}`,
          labelFormat: "PDF",
          labelBase64: "ZmFrZS1wZGY=",
          carrierCode: request.carrierCode,
          serviceCode: request.serviceCode,
          providerCostAmount: behavior.providerCostAmount ?? request.quotedProviderAmount ?? 0,
          currencyCode: request.currencyCode,
        }
      case "error":
        return {
          status: "ERROR",
          errorCode: behavior.errorCode,
          errorMessage: behavior.errorMessage ?? "fake label error",
          sideEffectMayHaveOccurred: behavior.sideEffectMayHaveOccurred ?? false,
          currentProviderAmount: behavior.currentProviderAmount,
        }
      case "throw":
        throw new Error(behavior.message ?? "FAKE_LABEL_PROVIDER_ERROR")
    }
  }
}
