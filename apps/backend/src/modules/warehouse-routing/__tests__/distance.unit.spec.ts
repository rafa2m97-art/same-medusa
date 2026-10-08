import { haversineDistanceKm } from "../rules/distance"

describe("haversineDistanceKm", () => {
  it("returns 0 for the same point", () => {
    expect(haversineDistanceKm({ latitude: 19.43, longitude: -99.13 }, { latitude: 19.43, longitude: -99.13 })).toBe(0)
  })

  it("returns ~half the earth's circumference for antipodal points", () => {
    const distance = haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
    expect(distance).toBeCloseTo(Math.PI * 6371, 1)
  })

  it("returns ~a quarter of the earth's circumference across the equator", () => {
    const distance = haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 })
    expect(distance).toBeCloseTo((Math.PI / 2) * 6371, 1)
  })

  it("is symmetric", () => {
    const a = { latitude: 25.67, longitude: -100.3 }
    const b = { latitude: 20.65, longitude: -103.35 }
    expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 10)
  })

  it("is monotonic: a closer point yields a smaller distance than a farther one", () => {
    const origin = { latitude: 19.43, longitude: -99.13 }
    const near = { latitude: 19.5, longitude: -99.2 }
    const far = { latitude: 32.5, longitude: -117.0 }
    expect(haversineDistanceKm(origin, near)).toBeLessThan(haversineDistanceKm(origin, far))
  })

  it("never returns NaN for valid coordinate ranges", () => {
    expect(Number.isNaN(haversineDistanceKm({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 }))).toBe(
      false
    )
  })
})
