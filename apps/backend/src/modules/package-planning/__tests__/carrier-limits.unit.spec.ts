import { isUnshippableForAnyCarrier, validateParcel, type ParcelLimits } from "../rules/carrier-limits"

const DEFAULT_LIMITS: ParcelLimits = {
  maxWeightKg: 30,
  maxLengthCm: 120,
  maxWidthCm: 80,
  maxHeightCm: 80,
  maxGirthCm: 300,
}

describe("validateParcel", () => {
  it("passes a parcel within all limits", () => {
    const result = validateParcel({ weightKg: 10, lengthCm: 40, widthCm: 30, heightCm: 20 }, DEFAULT_LIMITS)
    expect(result.valid).toBe(true)
    expect(result.exceeded).toEqual([])
  })

  it("fails on weight alone", () => {
    const result = validateParcel({ weightKg: 50, lengthCm: 40, widthCm: 30, heightCm: 20 }, DEFAULT_LIMITS)
    expect(result.valid).toBe(false)
    expect(result.exceeded[0]).toMatch(/peso/)
  })

  it("computes girth as length + 2*(width+height) and fails when it exceeds the limit", () => {
    const result = validateParcel({ weightKg: 5, lengthCm: 100, widthCm: 80, heightCm: 80 }, DEFAULT_LIMITS)
    expect(result.girthCm).toBe(100 + 2 * (80 + 80))
    expect(result.valid).toBe(false)
    expect(result.exceeded.some((e) => e.includes("perímetro"))).toBe(true)
  })

  it("reports every exceeded dimension, not just the first", () => {
    const result = validateParcel({ weightKg: 999, lengthCm: 999, widthCm: 999, heightCm: 999 }, DEFAULT_LIMITS)
    expect(result.exceeded.length).toBeGreaterThan(1)
  })
})

describe("isUnshippableForAnyCarrier", () => {
  const fedex: ParcelLimits = { maxWeightKg: 68, maxLengthCm: 274, maxWidthCm: 274, maxHeightCm: 274, maxGirthCm: 330 }
  const dhl: ParcelLimits = { maxWeightKg: 500, maxLengthCm: 150, maxWidthCm: 150, maxHeightCm: 100, maxGirthCm: 650 }

  it("is false when at least one carrier can take the parcel", () => {
    const heavy = { weightKg: 120, lengthCm: 100, widthCm: 80, heightCm: 60 }
    expect(isUnshippableForAnyCarrier(heavy, [fedex, dhl])).toBe(false)
  })

  it("is true when every known carrier rejects the parcel", () => {
    const impossible = { weightKg: 9999, lengthCm: 999, widthCm: 999, heightCm: 999 }
    expect(isUnshippableForAnyCarrier(impossible, [fedex, dhl])).toBe(true)
  })

  it("is false (never claims unshippable) when no carrier limits are known at all", () => {
    expect(isUnshippableForAnyCarrier({ weightKg: 9999, lengthCm: 999, widthCm: 999, heightCm: 999 }, [])).toBe(false)
  })
})
