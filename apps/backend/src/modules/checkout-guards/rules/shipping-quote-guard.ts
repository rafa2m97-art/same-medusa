import type { CheckoutGuardFailure } from "./taxonomy"

/**
 * Shipping Rate Guard (plan §23/§26/§27) — regla real confirmada por SSH
 * 2026-10-03 (`envia-shipping.php::get_shipping_rates`, comentario
 * textual real: "Request to quote, postalCode and state are required"):
 * cuando el request a Envia no tiene postal code/items/packages
 * completos, la integración real NO devuelve una tarifa de $0 -- regresa
 * un arreglo VACÍO de tarifas (ninguna opción). La protección real
 * contra "$0 accidental" es ESTRUCTURAL (ausencia de opción), nunca un
 * valor numérico. Este guard reproduce exactamente esa garantía: $0
 * solo pasa con `isFreeShipping === true` explícito; cualquier otro
 * camino hacia amount<=0 (faltante, nulo, parseo fallido) se trata como
 * "no hay tarifa", igual que el código real.
 *
 * `ShippingQuote` está ligada a la AllocationSnapshot (plan §26) -- un
 * cambio de Routing (ej. de un solo origen a split) invalida cualquier
 * quote calculada para la asignación anterior, nunca se reutiliza por
 * coincidencia.
 */

export interface ShippingQuoteInput {
  status: "active" | "expired" | "consumed"
  expiresAt: Date | null
  allocationSnapshotId: string
  amount: number | null
  currencyCode: string
  isFreeShipping: boolean
}

export interface ShippingQuoteGuardInput {
  quote: ShippingQuoteInput | null
  currentAllocationSnapshotId: string
  cartCurrencyCode: string
  now: Date
}

export type ShippingQuoteGuardResult =
  | { valid: true; amount: number }
  | { valid: false; failure: CheckoutGuardFailure }

export function evaluateShippingQuote(input: ShippingQuoteGuardInput): ShippingQuoteGuardResult {
  const { quote } = input

  if (!quote || quote.status === "consumed") {
    return {
      valid: false,
      failure: { failureCode: "SHIPPING_QUOTE_MISSING", failureStage: "SHIPPING_QUOTE_GUARD" },
    }
  }

  if (quote.status === "expired" || (quote.expiresAt && input.now.getTime() >= quote.expiresAt.getTime())) {
    return {
      valid: false,
      failure: { failureCode: "SHIPPING_QUOTE_EXPIRED", failureStage: "SHIPPING_QUOTE_GUARD" },
    }
  }

  if (quote.allocationSnapshotId !== input.currentAllocationSnapshotId) {
    return {
      valid: false,
      failure: {
        failureCode: "SHIPPING_QUOTE_ALLOCATION_MISMATCH",
        failureStage: "SHIPPING_QUOTE_GUARD",
        details: {
          quoteAllocationSnapshotId: quote.allocationSnapshotId,
          currentAllocationSnapshotId: input.currentAllocationSnapshotId,
        },
      },
    }
  }

  if (quote.currencyCode.toLowerCase() !== input.cartCurrencyCode.toLowerCase()) {
    return {
      valid: false,
      failure: {
        failureCode: "SHIPPING_QUOTE_CURRENCY_MISMATCH",
        failureStage: "SHIPPING_QUOTE_GUARD",
        details: { quoteCurrencyCode: quote.currencyCode, cartCurrencyCode: input.cartCurrencyCode },
      },
    }
  }

  const isValidPositiveAmount = quote.amount !== null && Number.isFinite(quote.amount) && quote.amount > 0

  if (quote.isFreeShipping) {
    // Free shipping explícito: 0 es válido; cualquier valor positivo también se acepta tal cual.
    return { valid: true, amount: isValidPositiveAmount ? (quote.amount as number) : 0 }
  }

  if (!isValidPositiveAmount) {
    // Nunca se asume $0 por un dato faltante/inválido -- mismo
    // comportamiento real que el array vacío de Envia.
    return {
      valid: false,
      failure: { failureCode: "SHIPPING_QUOTE_MISSING", failureStage: "SHIPPING_QUOTE_GUARD", details: { reason: "invalid_or_missing_amount" } },
    }
  }

  return { valid: true, amount: quote.amount as number }
}
