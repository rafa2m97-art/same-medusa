import type { RetryPolicy } from "../../supplier/types"

/**
 * Decisión PURA de "¿puedo reintentar esto AHORA?" (plan §25/§26),
 * usando SIEMPRE `SupplierOrderAdapter.getRetryPolicy()` -- nunca una
 * política hardcodeada por workflow (plan §25: "no hardcodear lógica
 * Exel dentro del workflow"). Generaliza
 * `wp_schedule_single_event(time() + delay, ...)` real (verificado SSH
 * 2026-10-06, `handle_send_failure`) a una función pura invocable en
 * cualquier momento: en vez de programar un cron, cada corrida del
 * workflow simplemente pregunta "¿ya pasó el backoff?" -- el efecto es
 * idéntico (mismo backoff real 5/15/60min) sin necesitar infraestructura
 * de scheduler nueva en esta etapa.
 */

export interface RetryEligibilityInput {
  attemptCount: number
  lastAttemptAt: Date | null
  lastErrorCode: string | null
  retryPolicy: RetryPolicy
  now: Date
}

export type RetryIneligibilityReason = "attempts_exhausted" | "non_retryable_error" | "backoff_not_elapsed"

export type RetryEligibility =
  | { eligible: true }
  | { eligible: false; reason: RetryIneligibilityReason; nextEligibleAt?: Date }

export function evaluateRetryEligibility(input: RetryEligibilityInput): RetryEligibility {
  if (input.lastErrorCode && input.retryPolicy.nonRetryableErrorCodes.includes(input.lastErrorCode)) {
    return { eligible: false, reason: "non_retryable_error" }
  }

  if (input.attemptCount >= input.retryPolicy.maxAttempts) {
    return { eligible: false, reason: "attempts_exhausted" }
  }

  if (!input.lastAttemptAt || input.attemptCount === 0) {
    return { eligible: true }
  }

  const backoffMs =
    input.retryPolicy.backoffMs[input.attemptCount - 1] ??
    input.retryPolicy.backoffMs[input.retryPolicy.backoffMs.length - 1] ??
    0
  const nextEligibleAt = new Date(input.lastAttemptAt.getTime() + backoffMs)

  if (input.now.getTime() < nextEligibleAt.getTime()) {
    return { eligible: false, reason: "backoff_not_elapsed", nextEligibleAt }
  }

  return { eligible: true }
}
