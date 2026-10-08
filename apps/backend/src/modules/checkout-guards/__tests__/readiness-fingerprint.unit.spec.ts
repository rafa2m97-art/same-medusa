import { computeReadinessFingerprint } from "../rules/readiness-fingerprint"

function baseInput() {
  return {
    cartFingerprint: "cart_fp",
    allocationSnapshotId: "as_1",
    authorizedAmount: 123,
    currencyCode: "mxn",
    shippingQuoteId: "sq_1",
    reservationIds: ["resitem_2", "resitem_1"],
    supplierConfirmedAt: "2026-10-03T12:00:00.000Z",
  }
}

describe("computeReadinessFingerprint", () => {
  it("is stable for the same inputs regardless of reservationIds order", () => {
    const a = computeReadinessFingerprint(baseInput())
    const b = computeReadinessFingerprint({ ...baseInput(), reservationIds: ["resitem_1", "resitem_2"] })
    expect(a).toBe(b)
  })

  it("changes when the authorized amount changes", () => {
    const a = computeReadinessFingerprint(baseInput())
    const b = computeReadinessFingerprint({ ...baseInput(), authorizedAmount: 124 })
    expect(a).not.toBe(b)
  })

  it("changes when the allocation snapshot id changes", () => {
    const a = computeReadinessFingerprint(baseInput())
    const b = computeReadinessFingerprint({ ...baseInput(), allocationSnapshotId: "as_2" })
    expect(a).not.toBe(b)
  })

  it("changes when the shipping quote id changes", () => {
    const a = computeReadinessFingerprint(baseInput())
    const b = computeReadinessFingerprint({ ...baseInput(), shippingQuoteId: "sq_2" })
    expect(a).not.toBe(b)
  })

  it("changes when the cart fingerprint itself changes (upstream cart mutation)", () => {
    const a = computeReadinessFingerprint(baseInput())
    const b = computeReadinessFingerprint({ ...baseInput(), cartFingerprint: "cart_fp_changed" })
    expect(a).not.toBe(b)
  })

  it("treats currency case-insensitively", () => {
    const a = computeReadinessFingerprint(baseInput())
    const b = computeReadinessFingerprint({ ...baseInput(), currencyCode: "MXN" })
    expect(a).toBe(b)
  })
})
