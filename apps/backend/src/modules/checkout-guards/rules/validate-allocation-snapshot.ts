import type { CheckoutGuardFailure } from "./taxonomy"

/**
 * Primer guard, pedido explícito (plan §4): antes de tocar reservas o
 * al proveedor, confirmar que la AllocationSnapshot elegida por Routing
 * (Etapa 6) sigue siendo utilizable. Si el carrito cambió, la respuesta
 * es SIEMPRE "allocation inválida -> requiere rerouting" — nunca un
 * intento de "arreglarla" silenciosamente (principio ya establecido en
 * Etapa 6 para el propio Routing, extendido aquí a Checkout).
 */

export interface AllocationSnapshotValidationInput {
  snapshotCartId: string
  requestCartId: string
  snapshotStatus: "draft" | "active" | "expired" | "superseded" | "consumed" | "invalidated"
  snapshotExpiresAt: Date | null
  snapshotFingerprint: string
  currentFingerprint: string
  now: Date
}

export type AllocationSnapshotValidationResult =
  | { valid: true }
  | { valid: false; failure: CheckoutGuardFailure }

export function validateAllocationSnapshot(
  input: AllocationSnapshotValidationInput
): AllocationSnapshotValidationResult {
  if (input.snapshotCartId !== input.requestCartId) {
    return {
      valid: false,
      failure: {
        failureCode: "ALLOCATION_INVALID",
        failureStage: "ALLOCATION_VALIDATION",
        details: { reason: "cart_mismatch" },
      },
    }
  }

  if (input.snapshotStatus !== "active") {
    return {
      valid: false,
      failure: {
        failureCode:
          input.snapshotStatus === "expired" ? "ALLOCATION_EXPIRED" : "ALLOCATION_INVALID",
        failureStage: "ALLOCATION_VALIDATION",
        details: { reason: "status_not_active", status: input.snapshotStatus },
      },
    }
  }

  if (input.snapshotExpiresAt && input.now.getTime() >= input.snapshotExpiresAt.getTime()) {
    return {
      valid: false,
      failure: {
        failureCode: "ALLOCATION_EXPIRED",
        failureStage: "ALLOCATION_VALIDATION",
        details: { reason: "expires_at_passed" },
      },
    }
  }

  // Cubre, en un solo chequeo, líneas/cantidades y destino relevante:
  // el fingerprint (Etapa 6, rules/fingerprint.ts) ya se calcula sobre
  // ambos -- un cambio en cualquiera de los dos cambia el hash.
  if (input.snapshotFingerprint !== input.currentFingerprint) {
    return {
      valid: false,
      failure: {
        failureCode: "CART_CHANGED",
        failureStage: "ALLOCATION_VALIDATION",
        details: { reason: "fingerprint_mismatch" },
      },
    }
  }

  return { valid: true }
}
