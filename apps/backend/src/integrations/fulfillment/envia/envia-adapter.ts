import type {
  NormalizedShippingRate,
  ShippingRateErrorCode,
  ShippingRateProvider,
  ShippingRateProviderResult,
  ShippingRateRequest,
} from "../../../modules/package-planning/types"
import type { EnviaRateResponse } from "./types"
import { buildEnviaRatePayload, normalizeEnviaRates } from "./normalize"

const ENVIA_RATE_BASE_URL = "https://api.envia.com"

export interface EnviaAdapterConfig {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
}

interface CarrierCallOutcome {
  carrierCode: string
  rates: NormalizedShippingRate[]
  errorCode?: ShippingRateErrorCode
  errorMessage?: string
}

/**
 * Cliente real de la API de Envia (plan §35) -- verificado por SSH
 * 2026-10-05 contra `class-same-dynamic-shipping.php`:
 * `POST {base}/ship/rate/`, `Authorization: Bearer {api_key}`. Una
 * llamada HTTP POR CARRIER (mismo patrón real: production hace N
 * llamadas, una por cada carrier solicitado, nunca una sola llamada
 * "todos los carriers").
 *
 * Responsabilidad única: auth + payload + llamada + normalización de
 * errores -- NUNCA Package Planning (plan §35: "no incluir Package
 * Planning aquí"). El algoritmo de empaque ya corrió antes; este
 * adapter solo cotiza los paquetes que ya le llegan armados.
 *
 * Sandbox lock real (plan §36): esta clase NO tiene, y nunca debe
 * tener, un método para comprar guía -- el contrato
 * `ShippingRateProvider` ni siquiera lo declara. No hay bandera
 * `label_purchase_enabled` que alguien pueda dejar en `true` por
 * error: la operación simplemente no existe en este código.
 */
export class EnviaAdapter implements ShippingRateProvider {
  readonly providerCode = "envia"
  private readonly config: EnviaAdapterConfig

  constructor(config: EnviaAdapterConfig) {
    this.config = config
  }

  async getRates(request: ShippingRateRequest): Promise<ShippingRateProviderResult> {
    const carriers = request.carrierCodes.length > 0 ? request.carrierCodes : ["fedex", "dhl", "estafeta"]

    const outcomes = await Promise.all(carriers.map((carrier) => this.requestCarrierRates(request, carrier)))

    const allRates = outcomes.flatMap((o) => o.rates)
    if (allRates.length > 0) {
      return { success: true, rates: allRates }
    }

    const failed = outcomes.filter((o) => o.errorCode)
    if (failed.length === outcomes.length && failed.length > 0) {
      // Todos los carriers fallaron de la MISMA forma -- propagar esa
      // razón explícita en vez de un NO_SERVICE_AVAILABLE engañoso.
      const first = failed[0]
      return { success: false, errorCode: first.errorCode!, errorMessage: first.errorMessage ?? "Envia request failed" }
    }

    // Ningún carrier devolvió error de transporte, pero tampoco hubo
    // tarifas usables (ej. todas dropOff, o todas <= 0) -- nunca se
    // asume $0 por esto (plan §30), se reporta como "sin servicio".
    return { success: false, errorCode: "NO_SERVICE_AVAILABLE", errorMessage: "Envia no devolvió tarifas utilizables" }
  }

  private async requestCarrierRates(request: ShippingRateRequest, carrierCode: string): Promise<CarrierCallOutcome> {
    const payload = buildEnviaRatePayload(request, carrierCode)
    const baseUrl = this.config.baseUrl ?? ENVIA_RATE_BASE_URL
    const timeoutMs = this.config.timeoutMs ?? 10_000

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${baseUrl}/ship/rate/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        return { carrierCode, rates: [], errorCode: "AUTH_ERROR", errorMessage: `Envia auth error (HTTP ${response.status})` }
      }
      if (response.status === 429) {
        return { carrierCode, rates: [], errorCode: "RATE_LIMITED", errorMessage: "Envia rate limit (HTTP 429)" }
      }
      if (response.status >= 500) {
        return { carrierCode, rates: [], errorCode: "PROVIDER_UNAVAILABLE", errorMessage: `Envia server error (HTTP ${response.status})` }
      }

      const body = (await response.json().catch(() => null)) as EnviaRateResponse | null
      if (response.status === 400) {
        return {
          carrierCode,
          rates: [],
          errorCode: "INVALID_ADDRESS",
          errorMessage: body?.error?.message ?? "Envia rejected the request (HTTP 400)",
        }
      }
      if (response.status < 200 || response.status >= 300 || !body || !Array.isArray(body.data)) {
        return { carrierCode, rates: [], errorCode: "INVALID_PROVIDER_RESPONSE", errorMessage: "Respuesta inesperada de Envia" }
      }

      return { carrierCode, rates: normalizeEnviaRates(body.data, request.currencyCode) }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { carrierCode, rates: [], errorCode: "PROVIDER_TIMEOUT", errorMessage: `Envia timeout tras ${timeoutMs}ms` }
      }
      return {
        carrierCode,
        rates: [],
        errorCode: "PROVIDER_UNAVAILABLE",
        errorMessage: error instanceof Error ? error.message : "Error desconocido llamando a Envia",
      }
    } finally {
      clearTimeout(timeoutHandle)
    }
  }
}
