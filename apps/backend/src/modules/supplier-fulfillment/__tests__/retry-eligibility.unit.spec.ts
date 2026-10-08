import { evaluateRetryEligibility } from "../rules/retry-eligibility"
import type { RetryPolicy } from "../../supplier/types"

const now = new Date("2026-10-06T12:00:00Z")
const REAL_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
  nonRetryableErrorCodes: ["local_config_error"],
}

describe("evaluateRetryEligibility", () => {
  it("es elegible en el primer intento (nunca hubo un intento previo)", () => {
    expect(
      evaluateRetryEligibility({ attemptCount: 0, lastAttemptAt: null, lastErrorCode: null, retryPolicy: REAL_RETRY_POLICY, now })
    ).toEqual({ eligible: true })
  })

  it("no es elegible antes de que pase el backoff real (5min tras el intento 1)", () => {
    const result = evaluateRetryEligibility({
      attemptCount: 1,
      lastAttemptAt: new Date(now.getTime() - 60_000),
      lastErrorCode: null,
      retryPolicy: REAL_RETRY_POLICY,
      now,
    })
    expect(result.eligible).toBe(false)
    if (result.eligible) throw new Error("unreachable")
    expect(result.reason).toBe("backoff_not_elapsed")
  })

  it("es elegible justo después de que pasa el backoff del intento correspondiente", () => {
    const result = evaluateRetryEligibility({
      attemptCount: 1,
      lastAttemptAt: new Date(now.getTime() - 5 * 60_000 - 1),
      lastErrorCode: null,
      retryPolicy: REAL_RETRY_POLICY,
      now,
    })
    expect(result).toEqual({ eligible: true })
  })

  it("usa el backoff del intento 2 (15min), no el del intento 1, cuando ya hubo 2 intentos", () => {
    const stillWaiting = evaluateRetryEligibility({
      attemptCount: 2,
      lastAttemptAt: new Date(now.getTime() - 10 * 60_000),
      lastErrorCode: null,
      retryPolicy: REAL_RETRY_POLICY,
      now,
    })
    expect(stillWaiting.eligible).toBe(false)
  })

  it("no es elegible tras agotar maxAttempts (3 intentos reales)", () => {
    const result = evaluateRetryEligibility({
      attemptCount: 3,
      lastAttemptAt: new Date(now.getTime() - 24 * 60 * 60_000),
      lastErrorCode: null,
      retryPolicy: REAL_RETRY_POLICY,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "attempts_exhausted" })
  })

  it("nunca es elegible para un error de configuración local, sin importar backoff/intentos", () => {
    const result = evaluateRetryEligibility({
      attemptCount: 0,
      lastAttemptAt: null,
      lastErrorCode: "local_config_error",
      retryPolicy: REAL_RETRY_POLICY,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "non_retryable_error" })
  })

  it("prioriza non_retryable_error sobre attempts_exhausted cuando ambos aplicarían", () => {
    const result = evaluateRetryEligibility({
      attemptCount: 5,
      lastAttemptAt: null,
      lastErrorCode: "local_config_error",
      retryPolicy: REAL_RETRY_POLICY,
      now,
    })
    expect(result).toEqual({ eligible: false, reason: "non_retryable_error" })
  })
})
