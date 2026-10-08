import { normalizeDimensionsCm, normalizeWeightKg } from "../rules/normalize-units"

describe("normalizeWeightKg", () => {
  it("leaves a realistic kg value untouched", () => {
    expect(normalizeWeightKg(12.5)).toBe(12.5)
  })

  it("detects grams mislabeled as kg above the 1000 threshold (real heuristic)", () => {
    expect(normalizeWeightKg(2500)).toBe(2.5)
  })

  it("does not touch a real heavy product just under the threshold (UPS trifásico-like, ~300kg)", () => {
    expect(normalizeWeightKg(300)).toBe(300)
  })

  it("floors to a minimum of 0.1kg", () => {
    expect(normalizeWeightKg(0)).toBe(0.1)
  })
})

describe("normalizeDimensionsCm", () => {
  it("leaves realistic cm dimensions untouched", () => {
    expect(normalizeDimensionsCm({ lengthCm: 40, widthCm: 30, heightCm: 20 })).toEqual({
      lengthCm: 40,
      widthCm: 30,
      heightCm: 20,
    })
  })

  it("detects millimeters mislabeled as cm above the 300 threshold", () => {
    expect(normalizeDimensionsCm({ lengthCm: 400, widthCm: 300, heightCm: 200 })).toEqual({
      lengthCm: 40,
      widthCm: 30,
      heightCm: 20,
    })
  })

  it("floors each dimension to a minimum of 1cm", () => {
    expect(normalizeDimensionsCm({ lengthCm: 0, widthCm: 0, heightCm: 0 })).toEqual({
      lengthCm: 1,
      widthCm: 1,
      heightCm: 1,
    })
  })
})
