import { computePackagePlanFingerprint } from "../rules/fingerprint"

function baseInput() {
  return {
    allocationSnapshotId: "as_1",
    supplierWarehouseId: "wh_1",
    lines: [{ variantId: "A", quantity: 2, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }],
    packingRuleVersion: "default-v1",
  }
}

describe("computePackagePlanFingerprint", () => {
  it("is stable regardless of line order", () => {
    const a = computePackagePlanFingerprint({
      ...baseInput(),
      lines: [
        { variantId: "B", quantity: 1, weightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 },
        { variantId: "A", quantity: 2, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 },
      ],
    })
    const b = computePackagePlanFingerprint({
      ...baseInput(),
      lines: [
        { variantId: "A", quantity: 2, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 },
        { variantId: "B", quantity: 1, weightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 },
      ],
    })
    expect(a).toBe(b)
  })

  it("changes when a dimension changes (plan §43)", () => {
    const a = computePackagePlanFingerprint(baseInput())
    const b = computePackagePlanFingerprint({
      ...baseInput(),
      lines: [{ variantId: "A", quantity: 2, weightKg: 1, lengthCm: 99, widthCm: 10, heightCm: 10 }],
    })
    expect(a).not.toBe(b)
  })

  it("changes when the allocation snapshot changes", () => {
    const a = computePackagePlanFingerprint(baseInput())
    const b = computePackagePlanFingerprint({ ...baseInput(), allocationSnapshotId: "as_2" })
    expect(a).not.toBe(b)
  })

  it("changes when the packing rule version changes", () => {
    const a = computePackagePlanFingerprint(baseInput())
    const b = computePackagePlanFingerprint({ ...baseInput(), packingRuleVersion: "default-v2" })
    expect(a).not.toBe(b)
  })
})
