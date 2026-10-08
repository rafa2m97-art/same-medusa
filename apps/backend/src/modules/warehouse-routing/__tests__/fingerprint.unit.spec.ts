import { computeAllocationFingerprint } from "../rules/fingerprint"

describe("computeAllocationFingerprint", () => {
  it("is identical for the same lines/destination regardless of line order", () => {
    const a = computeAllocationFingerprint({
      lines: [
        { variantId: "variant_a", quantity: 2 },
        { variantId: "variant_b", quantity: 1 },
      ],
      destinationState: "NL",
    })
    const b = computeAllocationFingerprint({
      lines: [
        { variantId: "variant_b", quantity: 1 },
        { variantId: "variant_a", quantity: 2 },
      ],
      destinationState: "NL",
    })
    expect(a).toBe(b)
  })

  it("changes when a quantity changes", () => {
    const a = computeAllocationFingerprint({
      lines: [{ variantId: "variant_a", quantity: 2 }],
      destinationState: "NL",
    })
    const b = computeAllocationFingerprint({
      lines: [{ variantId: "variant_a", quantity: 3 }],
      destinationState: "NL",
    })
    expect(a).not.toBe(b)
  })

  it("changes when the destination changes", () => {
    const a = computeAllocationFingerprint({
      lines: [{ variantId: "variant_a", quantity: 2 }],
      destinationState: "NL",
    })
    const b = computeAllocationFingerprint({
      lines: [{ variantId: "variant_a", quantity: 2 }],
      destinationState: "JAL",
    })
    expect(a).not.toBe(b)
  })

  it("treats a null destination distinctly from any real state", () => {
    const a = computeAllocationFingerprint({
      lines: [{ variantId: "variant_a", quantity: 2 }],
      destinationState: null,
    })
    const b = computeAllocationFingerprint({
      lines: [{ variantId: "variant_a", quantity: 2 }],
      destinationState: "",
    })
    expect(a).toBe(b)
  })
})
