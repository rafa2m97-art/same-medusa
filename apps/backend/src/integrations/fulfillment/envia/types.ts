/**
 * Formas CRUDAS reales de la API de Envia — verificadas por SSH
 * 2026-10-05 contra `class-same-dynamic-shipping.php`
 * (`build_envia_api_payload`/`request_envia_api_rates`/
 * `normalize_envia_shipments`). Nunca se usan fuera de este directorio.
 */

export interface EnviaRateAddress {
  name: string
  company: string
  email: string
  phone: string
  street: string
  number: string
  district: string
  city: string
  state: string
  country: string
  postalCode: string
}

export interface EnviaRatePackage {
  type: "box"
  content: string
  amount: number
  declaredValue: number
  lengthUnit: "CM"
  weightUnit: "KG"
  weight: number
  dimensions: { length: number; width: number; height: number }
}

export interface EnviaRatePayload {
  origin: EnviaRateAddress
  destination: EnviaRateAddress
  packages: EnviaRatePackage[]
  shipment: { type: number; carrier: string }
  settings: { currency: string }
}

/** Una fila de `response.data[]` -- campos reales confirmados. */
export interface EnviaRawRate {
  carrier?: string
  service?: string
  serviceDescription?: string
  aliasServiceDescription?: string
  serviceId?: string
  totalPrice?: number
  total_price?: number
  price?: number
  dropOff?: number | string
  quotationId?: string
  deliveryDate?: { dateDifference?: number }
  deliveryEstimate?: number | string
  delivery_estimate?: number | string
  deliveryDays?: number | string
  delivery_days?: number | string
}

export interface EnviaRateResponse {
  data?: EnviaRawRate[]
  meta?: string
  error?: { message?: string; code?: number }
}
