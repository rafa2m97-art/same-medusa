import { validateAllocationSnapshot } from "../rules/validate-allocation-snapshot"

const now = new Date("2026-10-03T12:00:00Z")

function baseInput() {
  return {
    snapshotCartId: "cart_1",
    requestCartId: "cart_1",
    snapshotStatus: "active" as const,
    snapshotExpiresAt: new Date("2026-10-03T12:30:00Z"),
    snapshotFingerprint: "abc",
    currentFingerprint: "abc",
    now,
  }
}

describe("validateAllocationSnapshot", () => {
  it("passes for an active, unexpired snapshot with a matching fingerprint", () => {
    expect(validateAllocationSnapshot(baseInput())).toEqual({ valid: true })
  })

  it("fails when the snapshot belongs to a different cart", () => {
    const result = validateAllocationSnapshot({ ...baseInput(), snapshotCartId: "cart_2" })
    expect(result).toEqual({
      valid: false,
      failure: { failureCode: "ALLOCATION_INVALID", failureStage: "ALLOCATION_VALIDATION", details: { reason: "cart_mismatch" } },
    })
  })

  it("fails with ALLOCATION_EXPIRED when the snapshot status is expired", () => {
    const result = validateAllocationSnapshot({ ...baseInput(), snapshotStatus: "expired" })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("ALLOCATION_EXPIRED")
  })

  it("fails with ALLOCATION_INVALID when the snapshot status is superseded", () => {
    const result = validateAllocationSnapshot({ ...baseInput(), snapshotStatus: "superseded" })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("ALLOCATION_INVALID")
  })

  it("fails with ALLOCATION_EXPIRED when now has passed expires_at even if status is still active", () => {
    const result = validateAllocationSnapshot({
      ...baseInput(),
      now: new Date("2026-10-03T13:00:00Z"),
    })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("ALLOCATION_EXPIRED")
  })

  it("fails with CART_CHANGED when the fingerprint no longer matches (quantity/lines/destination changed)", () => {
    const result = validateAllocationSnapshot({ ...baseInput(), currentFingerprint: "different" })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("unreachable")
    expect(result.failure.failureCode).toBe("CART_CHANGED")
  })

  it("passes when the snapshot has no expiration set at all", () => {
    expect(validateAllocationSnapshot({ ...baseInput(), snapshotExpiresAt: null })).toEqual({ valid: true })
  })
})
