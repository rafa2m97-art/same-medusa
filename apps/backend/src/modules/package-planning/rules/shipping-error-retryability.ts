import type { ShippingRateErrorCode } from "../types"

/**
 * Retry policy explícita (plan §40) — nunca reintentar ciegamente.
 * Mismo principio que `resolveFailureRetryability` (Etapa 7): una
 * tabla única y exhaustiva, nunca una decisión inline.
 *
 *   retryable=true  -> timeout, 5xx/unavailable, rate limit (transitorio).
 *   retryable=false -> 400/dirección invalida, paquete excede límites,
 *                       respuesta corrupta, error de autenticación --
 *                       repetir la MISMA llamada nunca lo arregla.
 */
const RETRYABLE_SHIPPING_ERRORS: Record<ShippingRateErrorCode, boolean> = {
  INVALID_ADDRESS: false,
  NO_SERVICE_AVAILABLE: false,
  PACKAGE_TOO_HEAVY: false,
  PACKAGE_TOO_LARGE: false,
  PROVIDER_TIMEOUT: true,
  PROVIDER_UNAVAILABLE: true,
  RATE_LIMITED: true,
  INVALID_PROVIDER_RESPONSE: false,
  AUTH_ERROR: false,
}

export function isRetryableShippingError(code: ShippingRateErrorCode): boolean {
  return RETRYABLE_SHIPPING_ERRORS[code]
}
