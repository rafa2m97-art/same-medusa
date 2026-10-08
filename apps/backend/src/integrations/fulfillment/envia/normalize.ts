import type { ShippingRateAddress, ShippingRateRequest, NormalizedShippingRate } from "../../../modules/package-planning/types"
import type { EnviaRateAddress, EnviaRatePayload, EnviaRawRate } from "./types"

/** Mismo mapeo real de `build_envia_destination`/`build_envia_api_payload`. */
function toEnviaAddress(address: ShippingRateAddress): EnviaRateAddress {
  return {
    name: address.name || "Cliente",
    company: address.company ?? "",
    email: address.email ?? "",
    phone: address.phone || "0000000000",
    street: address.street,
    number: address.number,
    district: address.district,
    city: address.city,
    state: address.state,
    country: address.country || "MX",
    postalCode: address.postalCode,
  }
}

export function buildEnviaRatePayload(request: ShippingRateRequest, carrierCode: string): EnviaRatePayload {
  return {
    origin: toEnviaAddress(request.origin),
    destination: toEnviaAddress(request.destination),
    packages: request.packages.map((pkg) => ({
      type: "box",
      content: "Producto",
      amount: 1,
      declaredValue: Math.round(pkg.declaredValue * 100) / 100,
      lengthUnit: "CM",
      weightUnit: "KG",
      weight: Math.max(0.1, pkg.weightKg),
      dimensions: {
        length: Math.max(1, pkg.lengthCm),
        width: Math.max(1, pkg.widthCm),
        height: Math.max(1, pkg.heightCm),
      },
    })),
    shipment: { type: 1, carrier: carrierCode },
    settings: { currency: request.currencyCode.toUpperCase() },
  }
}

/** Portado tal cual de `extract_envia_delivery_days()` real -- misma cadena de fallback de campos. */
function extractDeliveryDays(rate: EnviaRawRate): number | null {
  if (rate.deliveryDate && typeof rate.deliveryDate.dateDifference === "number") {
    return Math.trunc(rate.deliveryDate.dateDifference)
  }
  for (const field of ["deliveryEstimate", "delivery_estimate", "deliveryDays", "delivery_days"] as const) {
    const value = rate[field]
    if (value === undefined) continue
    if (typeof value === "number") return Math.trunc(value)
    const match = String(value).match(/\d+/)
    if (match) return Number.parseInt(match[0], 10)
  }
  return null
}

/**
 * Regla de negocio real confirmada: nunca ofrecer servicios "Ocurre"
 * (dropOff) -- recolección siempre en almacén del proveedor, entrega
 * siempre a domicilio del cliente.
 */
export function normalizeEnviaRates(rawRates: EnviaRawRate[], currencyCode: string): NormalizedShippingRate[] {
  const normalized: NormalizedShippingRate[] = []

  for (const raw of rawRates) {
    if (raw.dropOff) continue

    const amount = Number(raw.totalPrice ?? raw.total_price ?? raw.price ?? 0)
    if (!Number.isFinite(amount) || amount <= 0) continue

    const carrierCode = String(raw.carrier ?? "")
    const providerServiceCode = String(raw.service ?? "")
    const serviceCode = String(raw.serviceId ?? raw.service ?? "")
    const serviceName = String(raw.serviceDescription ?? raw.aliasServiceDescription ?? (providerServiceCode || "Envio"))

    normalized.push({
      carrierCode,
      serviceCode,
      serviceName,
      amount,
      currencyCode,
      estimatedDeliveryDays: extractDeliveryDays(raw),
      providerQuoteReference: raw.quotationId || null,
    })
  }

  return normalized
}
