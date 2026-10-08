import type { ShippingRateAddress, ShippingRatePackageInput } from "../package-planning/types"

/**
 * Contrato normalizado de COMPRA de guía (plan §12/§39/§40) —
 * deliberadamente SEPARADO de `ShippingRateProvider` (Etapa 8,
 * `package-planning/types.ts`, solo `getRates()`). Reutiliza
 * `ShippingRateAddress`/`ShippingRatePackageInput` porque son formas
 * YA normalizadas (no crudas de Envia) -- reutilizarlas no rompe el
 * guard estructural de Etapa 8 (ese guard prueba que `EnviaAdapter`
 * de RATE nunca expone compra de guía; este es un adapter DISTINTO).
 *
 * Nada crudo de Envia escapa de aquí hacia `supplier-fulfillment`
 * (verificado por test, igual que Etapa 8).
 */

export interface PurchaseShippingLabelRequest {
  origin: ShippingRateAddress
  destination: ShippingRateAddress
  packages: ShippingRatePackageInput[]
  carrierCode: string
  serviceCode: string | null
  /** La quote original (Etapa 8) -- el adapter debe comprar EXACTAMENTE esto, nunca re-elegir carrier/service (plan §13). */
  providerQuoteReference: string | null
  quotedProviderAmount: number | null
  currencyCode: string
  /**
   * Ancla de idempotencia (plan §16) -- estable por WarehouseShipment,
   * nunca regenerada entre reintentos. Si Envia soporta un campo de
   * referencia externa, el adapter lo usa aquí; si no, al menos deja
   * un rastro verificable en logs/reconciliación manual.
   */
  idempotencyKey: string
}

export type ShippingLabelErrorCode =
  | "LABEL_PROVIDER_UNAVAILABLE"
  | "LABEL_TIMEOUT"
  | "LABEL_RATE_CHANGED"
  | "LABEL_SERVICE_UNAVAILABLE"
  | "LABEL_PURCHASE_AMBIGUOUS"
  | "LABEL_INVALID_RESPONSE"

export type PurchaseShippingLabelResult =
  | {
      status: "PURCHASED"
      providerShipmentId: string
      trackingNumber: string
      labelFormat: "PDF" | "ZPL"
      /** Base64 crudo, SOLO de paso -- el caller lo persiste a storage y guarda la referencia, nunca el base64 en DB/logs (plan §18/§43). */
      labelBase64: string
      carrierCode: string
      serviceCode: string | null
      providerCostAmount: number
      currencyCode: string
    }
  | {
      status: "ERROR"
      errorCode: ShippingLabelErrorCode
      errorMessage: string
      /** ¿Pudo Envia haber creado la guía aunque esta respuesta sea un error? (plan §45) */
      sideEffectMayHaveOccurred: boolean
      /** Solo presente para LABEL_RATE_CHANGED -- el costo real que el provider reporta ahora. */
      currentProviderAmount?: number
    }

/**
 * Única capacidad nueva de Etapa 9. Nunca incluye Package
 * Planning/Routing/Pricing/Checkout (plan §8) -- solo integración con
 * el proveedor de guías.
 */
export interface ShippingLabelProvider {
  readonly providerCode: string
  purchaseLabel(request: PurchaseShippingLabelRequest): Promise<PurchaseShippingLabelResult>
}
