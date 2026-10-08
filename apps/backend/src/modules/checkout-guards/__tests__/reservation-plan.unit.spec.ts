import { planReservations, type DesiredReservation, type ExistingReservation } from "../rules/reservation-plan"

describe("planReservations", () => {
  it("plans a create for every desired reservation when none exist yet", () => {
    const desired: DesiredReservation[] = [
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_1", quantity: 2 },
    ]
    expect(planReservations(desired, [])).toEqual({
      toCreate: desired,
      toUpdate: [],
      toReuse: [],
      toRelease: [],
    })
  })

  it("reuses an existing reservation untouched when it already matches exactly (idempotent re-run: reserved stays 2, never 4)", () => {
    const desired: DesiredReservation[] = [
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_1", quantity: 2 },
    ]
    const existing: ExistingReservation[] = [
      { id: "resitem_1", lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_1", quantity: 2 },
    ]
    expect(planReservations(desired, existing)).toEqual({
      toCreate: [],
      toUpdate: [],
      toReuse: ["resitem_1"],
      toRelease: [],
    })
  })

  it("plans an update when the same reservation identity now needs a different quantity", () => {
    const desired: DesiredReservation[] = [
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_1", quantity: 3 },
    ]
    const existing: ExistingReservation[] = [
      { id: "resitem_1", lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_1", quantity: 2 },
    ]
    expect(planReservations(desired, existing)).toEqual({
      toCreate: [],
      toUpdate: [{ id: "resitem_1", quantity: 3 }],
      toReuse: [],
      toRelease: [],
    })
  })

  it("plans a release for a stale reservation whose origin is no longer part of the current allocation", () => {
    const desired: DesiredReservation[] = [
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_MX", quantity: 2 },
    ]
    const existing: ExistingReservation[] = [
      { id: "resitem_old", lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_MY", quantity: 2 },
    ]
    const plan = planReservations(desired, existing)
    expect(plan.toCreate).toEqual(desired)
    expect(plan.toRelease).toEqual(["resitem_old"])
  })

  it("handles a split line (multiple assignments for one line_item_id across different locations) independently", () => {
    const desired: DesiredReservation[] = [
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_GD", quantity: 3 },
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_MX", quantity: 4 },
    ]
    const plan = planReservations(desired, [])
    expect(plan.toCreate).toHaveLength(2)
    expect(plan.toRelease).toEqual([])
  })

  it("is a pure no-op (nothing to create/update/release) when re-run identically twice in a row", () => {
    const desired: DesiredReservation[] = [
      { lineItemId: "li_1", inventoryItemId: "ii_1", locationId: "sl_1", quantity: 2 },
      { lineItemId: "li_2", inventoryItemId: "ii_2", locationId: "sl_1", quantity: 1 },
    ]
    const existing: ExistingReservation[] = desired.map((d, i) => ({ id: `resitem_${i}`, ...d }))
    expect(planReservations(desired, existing)).toEqual({
      toCreate: [],
      toUpdate: [],
      toReuse: existing.map((e) => e.id),
      toRelease: [],
    })
  })
})
