import { resolveFulfillmentErrorProfile, type FulfillmentErrorCode } from "../rules/error-taxonomy"

const ALL_CODES: FulfillmentErrorCode[] = [
  "LABEL_PROVIDER_UNAVAILABLE",
  "LABEL_TIMEOUT",
  "LABEL_RATE_CHANGED",
  "LABEL_SERVICE_UNAVAILABLE",
  "LABEL_PURCHASE_AMBIGUOUS",
  "LABEL_INVALID_RESPONSE",
  "SUPPLIER_TIMEOUT",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_REJECTED",
  "SUPPLIER_VALIDATION_ERROR",
  "SUPPLIER_SUBMISSION_AMBIGUOUS",
]

describe("resolveFulfillmentErrorProfile", () => {
  it("tiene un perfil completo para cada código conocido", () => {
    for (const code of ALL_CODES) {
      const profile = resolveFulfillmentErrorProfile(code)
      expect(profile).toEqual(
        expect.objectContaining({
          retryable: expect.any(Boolean),
          sideEffectMayHaveOccurred: expect.any(Boolean),
          manualReviewRequired: expect.any(Boolean),
        })
      )
    }
  })

  it("nunca marca retryable=true cuando sideEffectMayHaveOccurred=true (invariante de seguridad, plan §45)", () => {
    for (const code of ALL_CODES) {
      const profile = resolveFulfillmentErrorProfile(code)
      if (profile.sideEffectMayHaveOccurred) {
        expect(profile.retryable).toBe(false)
      }
    }
  })

  it("timeout de compra de guía es ambiguo, nunca retryable automático", () => {
    expect(resolveFulfillmentErrorProfile("LABEL_TIMEOUT")).toEqual({
      retryable: false,
      sideEffectMayHaveOccurred: true,
      manualReviewRequired: true,
    })
  })

  it("proveedor de guía caído (nunca llegó a intentarse) sí es retryable", () => {
    expect(resolveFulfillmentErrorProfile("LABEL_PROVIDER_UNAVAILABLE")).toEqual({
      retryable: true,
      sideEffectMayHaveOccurred: false,
      manualReviewRequired: false,
    })
  })

  it("rechazo de validación del proveedor (dato malo) nunca es retryable ni ambiguo", () => {
    expect(resolveFulfillmentErrorProfile("SUPPLIER_VALIDATION_ERROR")).toEqual({
      retryable: false,
      sideEffectMayHaveOccurred: false,
      manualReviewRequired: true,
    })
  })
})
