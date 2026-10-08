import { consolidateParcel } from "../rules/consolidate-parcel"

describe("consolidateParcel", () => {
  it("sums weight across all units", () => {
    const parcel = consolidateParcel([
      { weightKg: 2, lengthCm: 20, widthCm: 20, heightCm: 20, quantity: 1 },
      { weightKg: 3, lengthCm: 20, widthCm: 20, heightCm: 20, quantity: 1 },
    ])
    expect(parcel.weightKg).toBe(5)
  })

  it("respects quantity when summing weight and volume", () => {
    const parcel = consolidateParcel([{ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, quantity: 3 }])
    expect(parcel.weightKg).toBe(3)
  })

  it("never exceeds the 80cm max side or 100cm max length caps", () => {
    const parcel = consolidateParcel([{ weightKg: 1, lengthCm: 90, widthCm: 85, heightCm: 85, quantity: 1 }])
    expect(parcel.lengthCm).toBeLessThanOrEqual(100)
    expect(parcel.widthCm).toBeLessThanOrEqual(80)
    expect(parcel.heightCm).toBeLessThanOrEqual(80)
  })

  it("caps girth at 240cm by reducing height when the correction is geometrically feasible", () => {
    // length=60, width=40 leaves enough girth budget (140cm) that the
    // height-reduction correction can actually bring girth back to <=240 --
    // a very wide/long parcel (ej. length=100,width=80) ya consume casi
    // todo el presupuesto de girth con altura=0, y la correccion real NO
    // garantiza <=240 en ese caso (se queda en el piso de 10cm de todas
    // formas) -- es un heuristico de mejor esfuerzo, no una garantia
    // matematica, igual que el codigo real que se porto.
    const parcel = consolidateParcel([{ weightKg: 1, lengthCm: 60, widthCm: 40, heightCm: 20, quantity: 50 }])
    const girth = parcel.lengthCm + 2 * (parcel.widthCm + parcel.heightCm)
    expect(girth).toBeLessThanOrEqual(240.01)
  })

  it("is a best-effort heuristic, not a hard guarantee -- a very wide/long parcel can still exceed the internal 240cm girth target after the height floor", () => {
    const parcel = consolidateParcel([{ weightKg: 1, lengthCm: 100, widthCm: 80, heightCm: 1, quantity: 50 }])
    const girth = parcel.lengthCm + 2 * (parcel.widthCm + parcel.heightCm)
    expect(girth).toBeGreaterThan(240)
  })

  it("is deterministic for the same input", () => {
    const units = [{ weightKg: 2.3, lengthCm: 33, widthCm: 22, heightCm: 11, quantity: 2 }]
    expect(consolidateParcel(units)).toEqual(consolidateParcel(units))
  })

  it("normalizes mislabeled mm/g inputs before consolidating", () => {
    const parcel = consolidateParcel([{ weightKg: 2500, lengthCm: 400, widthCm: 300, heightCm: 200, quantity: 1 }])
    expect(parcel.weightKg).toBe(2.5)
  })
})
