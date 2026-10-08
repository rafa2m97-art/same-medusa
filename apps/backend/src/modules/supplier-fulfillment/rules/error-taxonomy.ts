/**
 * Taxonomía de errores de fulfillment (plan §44) — separada de la de
 * Checkout Guards (Etapa 7) y de Package Planning (Etapa 8) porque
 * aquí las operaciones tienen efectos secundarios EXTERNOS reales
 * (comprar guía, enviar pedido) — la pregunta crítica añadida que no
 * existía antes es `sideEffectMayHaveOccurred` (plan §45): "¿pudo la
 * operación haber ocurrido del lado del proveedor aunque nosotros no
 * tengamos la confirmación?" Un timeout en una operación side-effecting
 * NUNCA es automáticamente retryable sin mirar esta bandera primero.
 */

export type FulfillmentErrorCode =
  | "LABEL_PROVIDER_UNAVAILABLE"
  | "LABEL_TIMEOUT"
  | "LABEL_RATE_CHANGED"
  | "LABEL_SERVICE_UNAVAILABLE"
  | "LABEL_PURCHASE_AMBIGUOUS"
  | "LABEL_INVALID_RESPONSE"
  | "SUPPLIER_TIMEOUT"
  | "SUPPLIER_UNAVAILABLE"
  | "SUPPLIER_REJECTED"
  | "SUPPLIER_VALIDATION_ERROR"
  | "SUPPLIER_SUBMISSION_AMBIGUOUS"

export interface FulfillmentErrorProfile {
  /** ¿Tiene sentido volver a intentar la MISMA operación automáticamente? */
  retryable: boolean
  /** ¿Pudo el side effect externo haber ocurrido aunque no tengamos confirmación? Si es true, NUNCA retry automático. */
  sideEffectMayHaveOccurred: boolean
  /** ¿Esto, por sí solo, ya requiere que un humano decida? */
  manualReviewRequired: boolean
}

/**
 * Nota de diseño: cualquier código con `sideEffectMayHaveOccurred: true`
 * tiene, por construcción, `retryable: false` -- un retry automático de
 * una operación cuyo efecto externo es ambiguo es exactamente lo que el
 * plan prohíbe explícitamente (§16/§45). La única salida de esos casos
 * es `REQUIRES_MANUAL_REVIEW` (reconciliación humana), nunca un reintento.
 */
const FULFILLMENT_ERROR_PROFILES: Record<FulfillmentErrorCode, FulfillmentErrorProfile> = {
  LABEL_PROVIDER_UNAVAILABLE: { retryable: true, sideEffectMayHaveOccurred: false, manualReviewRequired: false },
  LABEL_TIMEOUT: { retryable: false, sideEffectMayHaveOccurred: true, manualReviewRequired: true },
  LABEL_RATE_CHANGED: { retryable: false, sideEffectMayHaveOccurred: false, manualReviewRequired: true },
  LABEL_SERVICE_UNAVAILABLE: { retryable: false, sideEffectMayHaveOccurred: false, manualReviewRequired: true },
  LABEL_PURCHASE_AMBIGUOUS: { retryable: false, sideEffectMayHaveOccurred: true, manualReviewRequired: true },
  LABEL_INVALID_RESPONSE: { retryable: false, sideEffectMayHaveOccurred: true, manualReviewRequired: true },
  SUPPLIER_TIMEOUT: { retryable: false, sideEffectMayHaveOccurred: true, manualReviewRequired: true },
  SUPPLIER_UNAVAILABLE: { retryable: true, sideEffectMayHaveOccurred: false, manualReviewRequired: false },
  SUPPLIER_REJECTED: { retryable: false, sideEffectMayHaveOccurred: false, manualReviewRequired: true },
  SUPPLIER_VALIDATION_ERROR: { retryable: false, sideEffectMayHaveOccurred: false, manualReviewRequired: true },
  SUPPLIER_SUBMISSION_AMBIGUOUS: { retryable: false, sideEffectMayHaveOccurred: true, manualReviewRequired: true },
}

export function resolveFulfillmentErrorProfile(code: FulfillmentErrorCode): FulfillmentErrorProfile {
  return FULFILLMENT_ERROR_PROFILES[code]
}
