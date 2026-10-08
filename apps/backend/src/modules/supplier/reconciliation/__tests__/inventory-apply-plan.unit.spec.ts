import { planInventoryApply } from "../inventory-apply-plan"

function baseInput() {
  return {
    action: "APPLY" as const,
    mappingStatus: "active" as const,
    supplierProductStateStatus: null as "active" | "quarantined" | null,
    incomingSyncRunStartedAt: new Date("2026-10-02T10:00:00Z"),
    lastAppliedSyncRunStartedAt: null as Date | null,
    normalizedWarehouseLevels: [
      { supplierWarehouseId: "sw_my", quantity: 4, warehouseStatus: "active" as const },
      { supplierWarehouseId: "sw_mx", quantity: 6, warehouseStatus: "active" as const },
    ],
  }
}

describe("planInventoryApply — decisión pura de escritura segura", () => {
  it("QUARANTINE nunca procede, sin importar nada más (Inventory nunca re-evalúa confiabilidad)", () => {
    const result = planInventoryApply({ ...baseInput(), action: "QUARANTINE" })
    expect(result).toEqual({ proceed: false, reason: "not_apply" })
  })

  it("mapping inactivo nunca procede (§19)", () => {
    const result = planInventoryApply({ ...baseInput(), mappingStatus: "inactive" })
    expect(result).toEqual({ proceed: false, reason: "inactive_mapping" })
  })

  it("mientras el mapping SIGA quarantined, un run individual APPLY no toca Inventory (§8-§9, Last Known Good)", () => {
    const result = planInventoryApply({ ...baseInput(), supplierProductStateStatus: "quarantined" })
    expect(result).toEqual({ proceed: false, reason: "still_quarantined" })
  })

  it("un SyncRun que empezó ANTES del último aplicado es stale y se rechaza (§13)", () => {
    const result = planInventoryApply({
      ...baseInput(),
      incomingSyncRunStartedAt: new Date("2026-10-02T09:00:00Z"),
      lastAppliedSyncRunStartedAt: new Date("2026-10-02T10:00:00Z"),
    })
    expect(result).toEqual({ proceed: false, reason: "stale_sync_run" })
  })

  it("un SyncRun con el MISMO started_at que el último aplicado también se considera stale (no reaplicar el mismo run)", () => {
    const sameTime = new Date("2026-10-02T10:00:00Z")
    const result = planInventoryApply({
      ...baseInput(),
      incomingSyncRunStartedAt: sameTime,
      lastAppliedSyncRunStartedAt: sameTime,
    })
    expect(result.proceed).toEqual(false)
  })

  it("un SyncRun más nuevo que el último aplicado SÍ procede", () => {
    const result = planInventoryApply({
      ...baseInput(),
      incomingSyncRunStartedAt: new Date("2026-10-02T11:00:00Z"),
      lastAppliedSyncRunStartedAt: new Date("2026-10-02T10:00:00Z"),
    })
    expect(result.proceed).toEqual(true)
  })

  it("un almacén inactivo se EXCLUYE de los niveles a aplicar, sin bloquear los demás (§18)", () => {
    const result = planInventoryApply({
      ...baseInput(),
      normalizedWarehouseLevels: [
        { supplierWarehouseId: "sw_my", quantity: 4, warehouseStatus: "active" },
        { supplierWarehouseId: "sw_mx", quantity: 6, warehouseStatus: "inactive" },
      ],
    })
    expect(result).toEqual({
      proceed: true,
      levelsToApply: [{ supplierWarehouseId: "sw_my", quantity: 4 }],
    })
  })

  it("si TODOS los almacenes están inactivos, no hay nada que aplicar", () => {
    const result = planInventoryApply({
      ...baseInput(),
      normalizedWarehouseLevels: [
        { supplierWarehouseId: "sw_my", quantity: 4, warehouseStatus: "inactive" },
      ],
    })
    expect(result).toEqual({ proceed: false, reason: "no_active_warehouses" })
  })

  // Stock 0 (§6) — un valor real de cero debe sobrevivir intacto, nunca
  // filtrarse como si fuera "ausente" o falsy.
  it("stock 0 explícito se conserva en levelsToApply, no se descarta", () => {
    const result = planInventoryApply({
      ...baseInput(),
      normalizedWarehouseLevels: [
        { supplierWarehouseId: "sw_my", quantity: 0, warehouseStatus: "active" },
        { supplierWarehouseId: "sw_mx", quantity: 0, warehouseStatus: "active" },
      ],
    })
    expect(result).toEqual({
      proceed: true,
      levelsToApply: [
        { supplierWarehouseId: "sw_my", quantity: 0 },
        { supplierWarehouseId: "sw_mx", quantity: 0 },
      ],
    })
  })

  it("caso feliz normal: mapping activo, nunca quarantined, run más nuevo, almacenes activos -> procede con todos los niveles", () => {
    const result = planInventoryApply(baseInput())
    expect(result).toEqual({
      proceed: true,
      levelsToApply: [
        { supplierWarehouseId: "sw_my", quantity: 4 },
        { supplierWarehouseId: "sw_mx", quantity: 6 },
      ],
    })
  })

  it("mapping que ya salió de cuarentena (status=active) con contador alto SÍ procede normal", () => {
    const result = planInventoryApply({ ...baseInput(), supplierProductStateStatus: "active" })
    expect(result.proceed).toEqual(true)
  })
})
