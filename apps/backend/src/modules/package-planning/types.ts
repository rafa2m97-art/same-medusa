/**
 * Contrato normalizado de cotización de envío (plan §4/§23). El dominio
 * (`package-planning/`, `checkout-guards/`) solo conoce estas formas —
 * nunca el payload crudo de Envia. La traducción cruda<->normalizada
 * vive enteramente en `integrations/fulfillment/envia/`, mismo
 * principio que `SupplierAdapter` (Etapa 2) para proveedores.
 *
 * Diseñado confrontando estos contratos contra el código REAL de
 * producción (`class-same-dynamic-shipping.php`, SSH 2026-10-05) — no
 * son tipos inventados: endpoint real `POST /ship/rate/`, payload real
 * `origin/destination/packages/shipment/settings`, respuesta real
 * `{data: [...]}` con `carrier/service/serviceId/totalPrice/dropOff`.
 */

export interface ShippingRateAddress {
  name: string
  company?: string
  email?: string
  phone: string
  street: string
  number: string
  district: string
  city: string
  state: string
  country: string
  postalCode: string
}

export interface ShippingRatePackageInput {
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
  declaredValue: number
}

export interface ShippingRateRequest {
  origin: ShippingRateAddress
  destination: ShippingRateAddress
  packages: ShippingRatePackageInput[]
  carrierCodes: string[]
  currencyCode: string
}

/**
 * Regla de negocio real confirmada (comentario textual en
 * `normalize_envia_shipments`): "nunca ofrecer/comprar servicios
 * 'Ocurre' (dropOff=1) -- recolectamos siempre en almacén del
 * proveedor y entregamos siempre a domicilio del cliente." El
 * adaptador filtra esto ANTES de normalizar -- `isDropOff` ni siquiera
 * debería sobrevivir a `normalize.ts`, se deja aquí solo por si algún
 * día esa regla necesita revisarse explícitamente.
 */
export interface NormalizedShippingRate {
  carrierCode: string
  serviceCode: string
  serviceName: string
  amount: number
  currencyCode: string
  estimatedDeliveryDays: number | null
  providerQuoteReference: string | null
}

export type ShippingRateErrorCode =
  | "INVALID_ADDRESS"
  | "NO_SERVICE_AVAILABLE"
  | "PACKAGE_TOO_HEAVY"
  | "PACKAGE_TOO_LARGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "INVALID_PROVIDER_RESPONSE"
  | "AUTH_ERROR"

export type ShippingRateProviderResult =
  | { success: true; rates: NormalizedShippingRate[] }
  | { success: false; errorCode: ShippingRateErrorCode; errorMessage: string }

/**
 * Capacidad única (cotizar) -- deliberadamente NO incluye comprar guía
 * (plan §36: "label_purchase_enabled=false... aunque alguien configure
 * accidentalmente credenciales de producción, esta etapa NO puede
 * comprar guías"). El método para comprar guía simplemente no existe
 * en este contrato todavía -- el guard más fuerte posible, ninguna
 * bandera que alguien pueda dejar en `true` por error.
 */
export interface ShippingRateProvider {
  readonly providerCode: string
  getRates(request: ShippingRateRequest): Promise<ShippingRateProviderResult>
}
