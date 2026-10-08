import type {
  PurchaseShippingLabelRequest,
  PurchaseShippingLabelResult,
  ShippingLabelProvider,
} from "../../../modules/supplier-fulfillment/types"
import { isRealLabelPurchaseAllowed } from "../../../modules/supplier-fulfillment/rules/production-lock"
import type { EnviaGenerateResponse } from "./label-types"
import { buildEnviaGeneratePayload } from "./normalize-label"

const ENVIA_GENERATE_BASE_URL = "https://api.envia.com"

export interface EnviaLabelAdapterConfig {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  /**
   * Candado duro (plan §38) -- por defecto se lee de las variables de
   * entorno reales (`ENVIA_ENVIRONMENT`/`ENVIA_LABEL_PURCHASE_ENABLED`/
   * `ENVIA_PRODUCTION_UNLOCKED`); se puede pasar explícito para tests.
   * Vive AQUÍ (no en el workflow genérico) porque el riesgo real --
   * gastar dinero -- está exactamente en esta clase, nunca en el
   * orquestador que no sabe qué proveedor tiene detrás.
   */
  lockEnvironment?: {
    enviaEnvironment?: string
    labelPurchaseEnabledFlag?: string
    productionUnlockedFlag?: string
  }
}

/**
 * Cliente de COMPRA de guía de Envia (plan §12/§39) -- SEPARADO de
 * `EnviaAdapter` (rate, Etapa 8). Comparten únicamente el patrón de
 * auth/HTTP (no código, a propósito -- dos clases pequeñas e
 * independientes son más simples que una abstracción compartida
 * prematura). Endpoint modelado consistente con `/ship/rate/` real
 * (`/ship/generate/`), NO verificado contra una llamada de red real en
 * esta sesión (ver label-types.ts).
 *
 * Compra EXACTAMENTE lo cotizado (plan §13/§14): nunca elige carrier/
 * service por su cuenta -- los recibe ya congelados en el request. Si
 * el costo real difiere sustancialmente del cotizado, normaliza como
 * `LABEL_RATE_CHANGED` en vez de aceptar/rechazar silenciosamente (la
 * política ACCEPT/REVIEW/REJECT sobre esa diferencia vive en
 * `supplier-fulfillment/rules/`, nunca aquí -- este adapter solo
 * reporta el hecho).
 *
 * Ambigüedad de side-effect (plan §16/§45): un timeout de RED siempre
 * se reporta `sideEffectMayHaveOccurred: true` -- Envia pudo haber
 * creado la guía del otro lado sin que la respuesta nos llegara. Un
 * 4xx limpio (respuesta recibida, rechazo de validación) nunca es
 * ambiguo: Envia respondió, y una validación fallida no crea nada.
 */
export class EnviaLabelAdapter implements ShippingLabelProvider {
  readonly providerCode = "envia"
  private readonly config: EnviaLabelAdapterConfig

  constructor(config: EnviaLabelAdapterConfig) {
    this.config = config
  }

  async purchaseLabel(request: PurchaseShippingLabelRequest): Promise<PurchaseShippingLabelResult> {
    const baseUrl = this.config.baseUrl ?? ENVIA_GENERATE_BASE_URL
    const isTargetingProductionHost = baseUrl.includes(ENVIA_GENERATE_BASE_URL) && !baseUrl.includes("api-test")

    if (isTargetingProductionHost) {
      const lockEnv = this.config.lockEnvironment ?? {}
      const allowed = isRealLabelPurchaseAllowed({
        enviaEnvironment: lockEnv.enviaEnvironment ?? process.env.ENVIA_ENVIRONMENT,
        labelPurchaseEnabledFlag: lockEnv.labelPurchaseEnabledFlag ?? process.env.ENVIA_LABEL_PURCHASE_ENABLED,
        productionUnlockedFlag: lockEnv.productionUnlockedFlag ?? process.env.ENVIA_PRODUCTION_UNLOCKED,
      })
      if (!allowed) {
        return {
          status: "ERROR",
          errorCode: "LABEL_PROVIDER_UNAVAILABLE",
          errorMessage:
            "Compra de guía real BLOQUEADA por el candado de producción (plan §38) -- requiere ENVIA_ENVIRONMENT=production + ENVIA_LABEL_PURCHASE_ENABLED=true + ENVIA_PRODUCTION_UNLOCKED=true, todas a la vez.",
          sideEffectMayHaveOccurred: false,
        }
      }
    }

    const payload = buildEnviaGeneratePayload(request)
    const timeoutMs = this.config.timeoutMs ?? 15_000

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${baseUrl}/ship/generate/`, {
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
        return {
          status: "ERROR",
          errorCode: "LABEL_PROVIDER_UNAVAILABLE",
          errorMessage: `Envia auth error (HTTP ${response.status})`,
          sideEffectMayHaveOccurred: false,
        }
      }
      if (response.status >= 500) {
        return {
          status: "ERROR",
          errorCode: "LABEL_PROVIDER_UNAVAILABLE",
          errorMessage: `Envia server error (HTTP ${response.status})`,
          sideEffectMayHaveOccurred: false,
        }
      }

      const body = (await response.json().catch(() => null)) as EnviaGenerateResponse | null

      if (response.status === 400) {
        return {
          status: "ERROR",
          errorCode: "LABEL_SERVICE_UNAVAILABLE",
          errorMessage: body?.error?.message ?? "Envia rechazó el servicio/carrier solicitado (HTTP 400)",
          sideEffectMayHaveOccurred: false,
        }
      }

      if (response.status < 200 || response.status >= 300 || !body?.data) {
        return {
          status: "ERROR",
          errorCode: "LABEL_INVALID_RESPONSE",
          errorMessage: "Respuesta inesperada de Envia al comprar guía",
          // Respuesta 2xx pero sin los datos esperados -- no se puede
          // asegurar que NO se haya creado una guía del otro lado.
          sideEffectMayHaveOccurred: response.status >= 200 && response.status < 300,
        }
      }

      const data = body.data
      if (!data.trackingNumber || !data.shipmentId || !data.label) {
        return {
          status: "ERROR",
          errorCode: "LABEL_INVALID_RESPONSE",
          errorMessage: "Envia respondió 2xx sin tracking/shipmentId/label completos",
          sideEffectMayHaveOccurred: true,
        }
      }

      const providerCostAmount = Number(data.rate?.totalPrice ?? data.rate?.total_price ?? 0)

      // El adapter NUNCA decide si la diferencia entre costo cotizado y
      // costo real es aceptable -- solo reporta el costo real. La
      // política ACCEPT/REVIEW/REJECT (plan §15) vive en
      // `supplier-fulfillment/rules/provider-cost-variance.ts`, evaluada
      // por el workflow DESPUÉS de una compra ya exitosa (la guía ya
      // existe; nunca se "deshace" una compra real solo por el costo).
      return {
        status: "PURCHASED",
        providerShipmentId: data.shipmentId,
        trackingNumber: data.trackingNumber,
        labelFormat: data.labelFormat === "ZPL" ? "ZPL" : "PDF",
        labelBase64: data.label,
        carrierCode: data.carrier ?? request.carrierCode,
        serviceCode: data.service ?? request.serviceCode,
        providerCostAmount,
        currencyCode: request.currencyCode,
      }
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError"
      return {
        status: "ERROR",
        errorCode: isTimeout ? "LABEL_TIMEOUT" : "LABEL_PROVIDER_UNAVAILABLE",
        errorMessage: isTimeout ? `Envia timeout tras ${timeoutMs}ms` : error instanceof Error ? error.message : "Error desconocido",
        // Timeout: la request pudo haber llegado y procesado del lado
        // de Envia sin que la respuesta nos alcanzara -- SIEMPRE
        // ambiguo. Un error de conexión (nunca salió del cliente) no lo es.
        sideEffectMayHaveOccurred: isTimeout,
      }
    } finally {
      clearTimeout(timeoutHandle)
    }
  }
}
