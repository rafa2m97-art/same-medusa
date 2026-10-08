import { buildEnviaRatePayload, normalizeEnviaRates } from "../normalize"
import type { ShippingRateRequest } from "../../../../modules/package-planning/types"
import type { EnviaRawRate } from "../types"

function baseAddress() {
  return {
    name: "Cliente",
    phone: "8112345678",
    street: "Av. Siempre Viva",
    number: "123",
    district: "Centro",
    city: "Monterrey",
    state: "NLE",
    country: "MX",
    postalCode: "64000",
  }
}

function baseRequest(overrides: Partial<ShippingRateRequest> = {}): ShippingRateRequest {
  return {
    origin: baseAddress(),
    destination: baseAddress(),
    packages: [{ weightKg: 2, lengthCm: 20, widthCm: 15, heightCm: 10, declaredValue: 500 }],
    carrierCodes: ["fedex"],
    currencyCode: "mxn",
    ...overrides,
  }
}

describe("buildEnviaRatePayload", () => {
  it("builds the exact real payload shape (plan §3)", () => {
    const payload = buildEnviaRatePayload(baseRequest(), "fedex")
    expect(payload.shipment).toEqual({ type: 1, carrier: "fedex" })
    expect(payload.settings).toEqual({ currency: "MXN" })
    expect(payload.packages).toEqual([
      {
        type: "box",
        content: "Producto",
        amount: 1,
        declaredValue: 500,
        lengthUnit: "CM",
        weightUnit: "KG",
        weight: 2,
        dimensions: { length: 20, width: 15, height: 10 },
      },
    ])
  })

  it("uses the requested carrier code, not the request's default list", () => {
    const payload = buildEnviaRatePayload(baseRequest({ carrierCodes: ["fedex", "dhl"] }), "dhl")
    expect(payload.shipment.carrier).toBe("dhl")
  })

  it("floors weight/dimensions to Envia's real minimums (0.1kg / 1cm)", () => {
    const payload = buildEnviaRatePayload(
      baseRequest({ packages: [{ weightKg: 0, lengthCm: 0, widthCm: 0, heightCm: 0, declaredValue: 0 }] }),
      "fedex"
    )
    expect(payload.packages[0].weight).toBe(0.1)
    expect(payload.packages[0].dimensions).toEqual({ length: 1, width: 1, height: 1 })
  })

  it("defaults name/phone when the address is incomplete", () => {
    const payload = buildEnviaRatePayload(
      baseRequest({ origin: { ...baseAddress(), name: "", phone: "" } }),
      "fedex"
    )
    expect(payload.origin.name).toBe("Cliente")
    expect(payload.origin.phone).toBe("0000000000")
  })
})

describe("normalizeEnviaRates", () => {
  it("normalizes carrier/service/amount/eta from the real response fields", () => {
    const raw: EnviaRawRate[] = [
      {
        carrier: "fedex",
        service: "FEDEX_GROUND",
        serviceDescription: "FedEx Ground",
        serviceId: "svc-1",
        totalPrice: 150,
        quotationId: "q-1",
        deliveryDate: { dateDifference: 3 },
      },
    ]
    expect(normalizeEnviaRates(raw, "mxn")).toEqual([
      {
        carrierCode: "fedex",
        serviceCode: "svc-1",
        serviceName: "FedEx Ground",
        amount: 150,
        currencyCode: "mxn",
        estimatedDeliveryDays: 3,
        providerQuoteReference: "q-1",
      },
    ])
  })

  it("filters out dropOff ('Ocurre') services -- real business rule, never offered", () => {
    const raw: EnviaRawRate[] = [{ carrier: "fedex", totalPrice: 100, dropOff: 1 }]
    expect(normalizeEnviaRates(raw, "mxn")).toEqual([])
  })

  it("filters out rates with zero or missing price -- never a free rate by omission", () => {
    const raw: EnviaRawRate[] = [{ carrier: "fedex", totalPrice: 0 }, { carrier: "dhl" }]
    expect(normalizeEnviaRates(raw, "mxn")).toEqual([])
  })

  it("falls back through the real delivery-days field chain when deliveryDate is absent", () => {
    const raw: EnviaRawRate[] = [{ carrier: "fedex", totalPrice: 100, deliveryEstimate: "5 days" }]
    expect(normalizeEnviaRates(raw, "mxn")[0].estimatedDeliveryDays).toBe(5)
  })

  it("returns null delivery days when no ETA field is present at all", () => {
    const raw: EnviaRawRate[] = [{ carrier: "fedex", totalPrice: 100 }]
    expect(normalizeEnviaRates(raw, "mxn")[0].estimatedDeliveryDays).toBeNull()
  })

  it("falls back to the provider service code as the display name when no description exists", () => {
    const raw: EnviaRawRate[] = [{ carrier: "fedex", service: "FEDEX_2DAY", totalPrice: 100 }]
    expect(normalizeEnviaRates(raw, "mxn")[0].serviceName).toBe("FEDEX_2DAY")
  })
})
