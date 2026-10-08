import type {
  NormalizedShippingRate,
  ShippingRateErrorCode,
  ShippingRateProvider,
  ShippingRateProviderResult,
  ShippingRateRequest,
} from "../types"

/**
 * Doble de pruebas para `ShippingRateProvider` — equivalente a
 * `FakeSupplierAdapter` (Etapa 7). Nunca llama a Envia real; control
 * remoto total del comportamiento para tests (plan §16/§56: "si no hay
 * credenciales disponibles, usa fixtures... deja la prueba de red como
 * follow-up explícito").
 */
export type FakeShippingRateBehavior =
  | { mode: "success"; rates: NormalizedShippingRate[] }
  | { mode: "error"; errorCode: ShippingRateErrorCode; errorMessage?: string }
  | { mode: "throw"; message?: string }

export class FakeShippingRateProvider implements ShippingRateProvider {
  readonly providerCode: string
  private behavior: FakeShippingRateBehavior
  public lastRequest: ShippingRateRequest | null = null
  public callCount = 0

  constructor(providerCode = "fake-envia", behavior: FakeShippingRateBehavior = { mode: "success", rates: [] }) {
    this.providerCode = providerCode
    this.behavior = behavior
  }

  setBehavior(behavior: FakeShippingRateBehavior): void {
    this.behavior = behavior
  }

  async getRates(request: ShippingRateRequest): Promise<ShippingRateProviderResult> {
    this.lastRequest = request
    this.callCount += 1

    switch (this.behavior.mode) {
      case "success":
        return { success: true, rates: this.behavior.rates }
      case "error":
        return { success: false, errorCode: this.behavior.errorCode, errorMessage: this.behavior.errorMessage ?? "fake error" }
      case "throw":
        throw new Error(this.behavior.message ?? "FAKE_SHIPPING_PROVIDER_ERROR")
    }
  }
}

export function fakeRate(overrides: Partial<NormalizedShippingRate> = {}): NormalizedShippingRate {
  return {
    carrierCode: "fedex",
    serviceCode: "FEDEX_GROUND",
    serviceName: "FedEx Ground",
    amount: 120,
    currencyCode: "mxn",
    estimatedDeliveryDays: 3,
    providerQuoteReference: "fake-quote-ref",
    ...overrides,
  }
}
