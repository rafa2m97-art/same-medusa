import type { LiveConfirmationStatus } from "../../supplier/types"
import type { CheckoutGuardFailure } from "./taxonomy"

/**
 * Agrega los resultados normalizados de `confirmAllocationLive()` de
 * TODOS los proveedores involucrados en la allocation (plan §16/§17).
 * Puro: cada resultado ya llegó normalizado (CONFIRMED/REJECTED/
 * UNAVAILABLE/TIMEOUT/ERROR/CIRCUIT_OPEN) -- esta función no sabe qué
 * proveedor es Exel o Syscom, ni qué significan sus códigos de error
 * nativos (plan §42: "ExelAdapter puede internamente... pero Checkout
 * solo conoce confirmed/rejected/unavailable/details").
 *
 * All-confirmations-required real (plan §17): si CUALQUIERA no
 * confirma, el resultado agregado es NOT_READY completo -- nunca un
 * "parcialmente confirmado".
 *
 * Precedencia de failureCode cuando hay varias fallas: un rechazo
 * explícito (REJECTED, "el proveedor dijo que no hay stock") es más
 * específico/actionable que una indisponibilidad (timeout/error/
 * circuito abierto) -- si ambos ocurren a la vez, se reporta el
 * rechazo, con el detalle de TODOS los resultados para explainability
 * (mismo principio que los `shortages` completos de Etapa 6).
 */

export interface SupplierConfirmationOutcome {
  supplierId: string
  status: LiveConfirmationStatus | "CIRCUIT_OPEN"
  reason?: string
}

export type LiveSupplierConfirmationResult =
  | { allConfirmed: true }
  | { allConfirmed: false; failure: CheckoutGuardFailure }

export function evaluateLiveSupplierConfirmations(
  outcomes: SupplierConfirmationOutcome[]
): LiveSupplierConfirmationResult {
  const failing = outcomes.filter((o) => o.status !== "CONFIRMED")

  if (failing.length === 0) {
    return { allConfirmed: true }
  }

  const hasRejection = failing.some((o) => o.status === "REJECTED")

  return {
    allConfirmed: false,
    failure: {
      failureCode: hasRejection ? "SUPPLIER_STOCK_REJECTED" : "SUPPLIER_UNAVAILABLE",
      failureStage: "LIVE_SUPPLIER_CONFIRMATION",
      details: { outcomes: failing },
    },
  }
}
