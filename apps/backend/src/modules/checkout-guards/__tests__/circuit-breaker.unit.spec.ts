import { evaluateCircuitBreaker } from "../rules/circuit-breaker"

const now = new Date("2026-10-03T12:05:00Z")
const COOLDOWN_MS = 300_000 // 300s, el default real confirmado (FAILURE_TTL)

describe("evaluateCircuitBreaker", () => {
  it("is closed when there has never been a recorded failure", () => {
    expect(evaluateCircuitBreaker({ lastFailureAt: null }, { cooldownMs: COOLDOWN_MS, now })).toEqual({
      open: false,
    })
  })

  it("opens immediately on a single failure (never waits for N consecutive, matching the real live-stock circuit)", () => {
    const lastFailureAt = new Date(now.getTime() - 1000)
    expect(evaluateCircuitBreaker({ lastFailureAt }, { cooldownMs: COOLDOWN_MS, now })).toEqual({ open: true })
  })

  it("stays open while elapsed time is under the cooldown", () => {
    const lastFailureAt = new Date(now.getTime() - 299_000)
    expect(evaluateCircuitBreaker({ lastFailureAt }, { cooldownMs: COOLDOWN_MS, now })).toEqual({ open: true })
  })

  it("closes once the cooldown has fully elapsed", () => {
    const lastFailureAt = new Date(now.getTime() - 300_001)
    expect(evaluateCircuitBreaker({ lastFailureAt }, { cooldownMs: COOLDOWN_MS, now })).toEqual({ open: false })
  })

  it("respects a different, explicitly configured cooldown instead of a hardcoded 300s", () => {
    const lastFailureAt = new Date(now.getTime() - 61_000)
    expect(evaluateCircuitBreaker({ lastFailureAt }, { cooldownMs: 60_000, now })).toEqual({ open: false })
  })
})
