/**
 * Taxonomía estable de Etapa 7 (plan §39/§40) — códigos que el frontend/
 * API puede usar para decidir qué hacer, sin depender de mensajes
 * humanos. Cada código tiene una retryability FIJA (una tabla, no un
 * juicio ad-hoc por guard) — exactamente lo que pide §40: "cada error
 * debe indicar si tiene sentido retry / reroute / acción del cliente."
 *
 * `retryable`: reintentar la MISMA preparación tiene sentido (ej. un
 * timeout del proveedor puede resolverse solo).
 * `requiresReallocation`: el carrito/allocation ya no es válido — hay
 * que volver a correr Routing (Etapa 6) conscientemente, nunca
 * automático dentro de este guard (plan §35).
 * `customerActionRequired`: nada que el backend pueda resolver solo —
 * el cliente debe cambiar algo (dirección, revisar carrito).
 */

export type CheckoutFailureStage =
  | "ALLOCATION_VALIDATION"
  | "PRICE_GUARD"
  | "RESERVATION"
  | "LIVE_SUPPLIER_CONFIRMATION"
  | "ADDRESS_GUARD"
  | "SHIPPING_QUOTE_GUARD"

export type CheckoutFailureCode =
  | "CART_CHANGED"
  | "ALLOCATION_EXPIRED"
  | "ALLOCATION_INVALID"
  | "PRICE_CHANGED"
  | "PRICE_INVALID"
  | "PRICE_REQUIRES_REVIEW"
  | "LOCAL_STOCK_CHANGED"
  | "RESERVATION_FAILED"
  | "SUPPLIER_STOCK_REJECTED"
  | "SUPPLIER_UNAVAILABLE"
  | "ADDRESS_INCOMPLETE"
  | "SHIPPING_QUOTE_MISSING"
  | "SHIPPING_QUOTE_EXPIRED"
  | "SHIPPING_QUOTE_ALLOCATION_MISMATCH"
  | "SHIPPING_QUOTE_CURRENCY_MISMATCH"
  | "SHIPPING_QUOTE_PACKAGE_PLAN_MISMATCH"

export interface FailureRetryabilityProfile {
  retryable: boolean
  requiresReallocation: boolean
  customerActionRequired: boolean
}

/**
 * Única fuente de verdad para retryability — nunca decidida inline en
 * un guard. Si un código nuevo se agrega a `CheckoutFailureCode`, TypeScript
 * obliga a agregarlo aquí también (objeto exhaustivo por tipo).
 */
const FAILURE_RETRYABILITY: Record<CheckoutFailureCode, FailureRetryabilityProfile> = {
  CART_CHANGED: { retryable: false, requiresReallocation: true, customerActionRequired: false },
  ALLOCATION_EXPIRED: { retryable: false, requiresReallocation: true, customerActionRequired: false },
  ALLOCATION_INVALID: { retryable: false, requiresReallocation: true, customerActionRequired: false },
  PRICE_CHANGED: { retryable: false, requiresReallocation: false, customerActionRequired: true },
  PRICE_INVALID: { retryable: false, requiresReallocation: false, customerActionRequired: false },
  PRICE_REQUIRES_REVIEW: { retryable: false, requiresReallocation: false, customerActionRequired: false },
  LOCAL_STOCK_CHANGED: { retryable: false, requiresReallocation: true, customerActionRequired: false },
  RESERVATION_FAILED: { retryable: false, requiresReallocation: true, customerActionRequired: false },
  SUPPLIER_STOCK_REJECTED: { retryable: false, requiresReallocation: true, customerActionRequired: false },
  SUPPLIER_UNAVAILABLE: { retryable: true, requiresReallocation: false, customerActionRequired: false },
  ADDRESS_INCOMPLETE: { retryable: false, requiresReallocation: false, customerActionRequired: true },
  SHIPPING_QUOTE_MISSING: { retryable: true, requiresReallocation: false, customerActionRequired: false },
  SHIPPING_QUOTE_EXPIRED: { retryable: true, requiresReallocation: false, customerActionRequired: false },
  SHIPPING_QUOTE_ALLOCATION_MISMATCH: { retryable: true, requiresReallocation: false, customerActionRequired: false },
  SHIPPING_QUOTE_CURRENCY_MISMATCH: { retryable: true, requiresReallocation: false, customerActionRequired: false },
  // Etapa 8: la quote apunta a un PackagePlan que ya no está activo
  // (fue re-empacado/superseded) -- retryable porque re-correr
  // Package Planning + cotización arregla esto solo, sin tocar la
  // allocation de Routing (nunca requiresReallocation).
  SHIPPING_QUOTE_PACKAGE_PLAN_MISMATCH: { retryable: true, requiresReallocation: false, customerActionRequired: false },
}

export function resolveFailureRetryability(code: CheckoutFailureCode): FailureRetryabilityProfile {
  return FAILURE_RETRYABILITY[code]
}

export interface CheckoutGuardFailure {
  failureCode: CheckoutFailureCode
  failureStage: CheckoutFailureStage
  details?: Record<string, unknown>
}
