/**
 * Formas crudas del endpoint de COMPRA de guía de Envia. A diferencia
 * de `types.ts` (rate, `/ship/rate/`, verificado contra código real de
 * producción), estas formas se MODELAN consistentes con el mismo
 * patrón real confirmado (`origin/destination/packages/shipment/
 * settings`, SSH 2026-10-05/06) — el endpoint `/ship/generate/` sigue
 * la convención pública de Envia pero **no fue verificado contra una
 * llamada de red real en esta sesión** (ver reporte de cierre, "Caso
 * A" igual que Etapa 8).
 */

export interface EnviaGenerateAddress {
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

export interface EnviaGeneratePackage {
  type: "box"
  content: string
  amount: number
  declaredValue: number
  lengthUnit: "CM"
  weightUnit: "KG"
  weight: number
  dimensions: { length: number; width: number; height: number }
}

export interface EnviaGeneratePayload {
  origin: EnviaGenerateAddress
  destination: EnviaGenerateAddress
  packages: EnviaGeneratePackage[]
  shipment: { type: number; carrier: string; service: string | null }
  settings: { currency: string }
  /** Referencia propia de SAME -- idempotencia del lado del cliente (nunca confirmado que Envia la deduplique, ver docblock de envia-label-adapter.ts). */
  reference: string
}

export interface EnviaGenerateRateInfo {
  totalPrice?: number
  total_price?: number
}

export interface EnviaGenerateResponseData {
  shipmentId?: string
  trackingNumber?: string
  trackingUrl?: string
  label?: string
  labelFormat?: string
  carrier?: string
  service?: string
  rate?: EnviaGenerateRateInfo
}

export interface EnviaGenerateResponse {
  data?: EnviaGenerateResponseData
  meta?: string
  error?: { message?: string; code?: number }
}
