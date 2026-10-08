import type { PurchaseShippingLabelRequest } from "../../../modules/supplier-fulfillment/types"
import type { EnviaGenerateAddress, EnviaGeneratePayload } from "./label-types"

function toEnviaAddress(address: PurchaseShippingLabelRequest["origin"]): EnviaGenerateAddress {
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

/**
 * Mismo mapeo de dirección/paquete que `normalize.ts` (rate, Etapa 8) a
 * propósito -- es la MISMA forma normalizada de origen/destino/paquete,
 * nunca se reinventa. `reference` usa el `idempotencyKey` (estable por
 * WarehouseShipment) como referencia propia enviada a Envia.
 */
export function buildEnviaGeneratePayload(request: PurchaseShippingLabelRequest): EnviaGeneratePayload {
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
    shipment: { type: 1, carrier: request.carrierCode, service: request.serviceCode },
    settings: { currency: request.currencyCode.toUpperCase() },
    reference: request.idempotencyKey,
  }
}
