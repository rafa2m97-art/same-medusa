import * as fs from "fs"
import * as path from "path"
import { classifyConflicts } from "../classify-conflicts"
import { classifyAbsentMappings } from "../classify-absent-mappings"
import { nextQuarantineState } from "../quarantine-state"
import { deriveSyncRunFinalStatus } from "../sync-run-status"
import { computeSourceSnapshotChecksum } from "../sync-run-identity"
import {
  InMemoryCommerceAuditEmitter,
} from "../../../commerce-audit/events"
import type { ReconciliationContext, ReconciliationRow } from "../types"

const GOLDEN_DIR = path.join(__dirname, "../__fixtures__/golden")

function loadGolden(filename: string) {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, filename), "utf-8"))
}

const BASE_CONTEXT: ReconciliationContext = {
  matchingMappingIds: ["mapping_1"],
  isDuplicateReferenceInSnapshot: false,
  upstreamError: false,
}

describe("classifyConflicts — golden fixtures (incidentes reales)", () => {
  // 22. golden fixture de un incidente real reproduce la clasificación esperada.
  it("reproduce CONFLICTING_WAREHOUSE_VALUES del incidente real 2026-09-16 (3MPADHAB001)", () => {
    const fixture = loadGolden("incidente-2026-09-16-conflicting-warehouse-values.json")
    const result = classifyConflicts(fixture.row, BASE_CONTEXT)
    expect(result.action).toEqual(fixture.expected.action)
    expect((result as any).conflictType).toEqual(fixture.expected.conflictType)
  })

  it("reproduce TOTAL_WAREHOUSE_MISMATCH del incidente real 2026-09-16 (3MCACCAC016/WR209MB)", () => {
    const fixture = loadGolden("incidente-2026-09-16-total-warehouse-mismatch.json")
    const result = classifyConflicts(fixture.row, BASE_CONTEXT)
    expect(result.action).toEqual(fixture.expected.action)
    expect((result as any).conflictType).toEqual(fixture.expected.conflictType)
  })
})

describe("classifyConflicts — casos del dominio (sintéticos, no inventados sin base)", () => {
  function row(overrides: Partial<ReconciliationRow>): ReconciliationRow {
    return {
      supplierSku: "SKU-TEST",
      catalogTotal: 0,
      warehouseReadings: [],
      knownWarehouseCodes: ["GD", "MX", "MY", "TR"],
      ...overrides,
    }
  }

  // 5. catalog total == warehouse sum -> APPLY. Caso A del pedido del usuario.
  it("Caso A — catalog_total == suma de almacenes -> APPLY CONFIRMED_WITH_LOCATIONS", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 10,
        warehouseReadings: [
          { warehouseExternalCode: "MY", quantity: 4 },
          { warehouseExternalCode: "MX", quantity: 6 },
        ],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({
      action: "APPLY",
      reason: "CONFIRMED_WITH_LOCATIONS",
      resolvedTotal: 10,
      warehouseTotals: { GD: 0, MX: 6, MY: 4, TR: 0 },
    })
  })

  // 6. catalog > 0 y warehouse sum = 0 -> QUARANTINE. Caso B.
  it("Caso B — catalog_total positivo, almacenes en cero -> QUARANTINE TOTAL_WAREHOUSE_MISMATCH", () => {
    const result = classifyConflicts(row({ catalogTotal: 11 }), BASE_CONTEXT)
    expect(result).toMatchObject({
      action: "QUARANTINE",
      conflictType: "TOTAL_WAREHOUSE_MISMATCH",
    })
  })

  // 7. mismatch grande -> QUARANTINE. Caso C — DIFERENCIA DELIBERADA vs.
  // producción real (ver classify-conflicts.ts): hoy esto se aplica sin
  // cuarentena con el total optimista. Aquí nunca.
  it("Caso C — catalog_total=90, suma=2 (ambos positivos) -> QUARANTINE, nunca por 'ambos positivos'", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 90,
        warehouseReadings: [{ warehouseExternalCode: "MX", quantity: 2 }],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({
      action: "QUARANTINE",
      conflictType: "TOTAL_WAREHOUSE_MISMATCH",
    })
  })

  // 8. 0/0 válido -> clasificación correcta. Caso D.
  it("Caso D — catalog_total=0 y suma=0 -> APPLY CONFIRMED_ZERO (no se asume que 0 es error)", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 0,
        warehouseReadings: [
          { warehouseExternalCode: "GD", quantity: 0 },
          { warehouseExternalCode: "MX", quantity: 0 },
        ],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({ action: "APPLY", reason: "CONFIRMED_ZERO", resolvedTotal: 0 })
  })

  // 9. missing catalog row. Caso E.
  it("Caso E — existe en almacenes pero no en catálogo -> QUARANTINE MISSING_CATALOG_ROW", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: null,
        warehouseReadings: [{ warehouseExternalCode: "MY", quantity: 3 }],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "MISSING_CATALOG_ROW" })
  })

  // 10. missing warehouse row. Caso E, espejo.
  it("Caso E (espejo) — existe en catálogo pero nunca apareció en almacenes -> QUARANTINE MISSING_WAREHOUSE_BREAKDOWN", () => {
    const result = classifyConflicts(row({ catalogTotal: 5, warehouseReadings: null }), BASE_CONTEXT)
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "MISSING_WAREHOUSE_BREAKDOWN" })
  })

  // 11. duplicate reference. Caso G (a nivel de snapshot completo, no de almacén).
  it("Caso G — el sku aparece dos veces como fila de nivel superior en el snapshot -> QUARANTINE DUPLICATE_REFERENCE", () => {
    const result = classifyConflicts(row({ catalogTotal: 5 }), {
      ...BASE_CONTEXT,
      isDuplicateReferenceInSnapshot: true,
    })
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "DUPLICATE_REFERENCE" })
  })

  // 12. invalid negative stock. Caso H.
  it("Caso H — cantidad negativa en un almacén -> QUARANTINE NEGATIVE_QUANTITY", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 5,
        warehouseReadings: [{ warehouseExternalCode: "MY", quantity: -3 }],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "NEGATIVE_QUANTITY" })
  })

  it("Caso H — cantidad no numérica en un almacén -> QUARANTINE NON_NUMERIC_QUANTITY", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 5,
        warehouseReadings: [{ warehouseExternalCode: "MY", quantity: null }],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "NON_NUMERIC_QUANTITY" })
  })

  it("Caso H — almacén desconocido para este proveedor -> QUARANTINE UNKNOWN_WAREHOUSE", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 5,
        warehouseReadings: [{ warehouseExternalCode: "QR", quantity: 5 }],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "UNKNOWN_WAREHOUSE" })
  })

  it("Caso H — falta supplierSku -> QUARANTINE MISSING_SKU", () => {
    const result = classifyConflicts(row({ supplierSku: "" }), BASE_CONTEXT)
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "MISSING_SKU" })
  })

  // 13. unknown SupplierProductMapping.
  it("ningún SupplierProductMapping coincide -> QUARANTINE UNKNOWN_PRODUCT_MAPPING", () => {
    const result = classifyConflicts(row({ catalogTotal: 5 }), {
      ...BASE_CONTEXT,
      matchingMappingIds: [],
    })
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "UNKNOWN_PRODUCT_MAPPING" })
  })

  it("más de un SupplierProductMapping coincide -> QUARANTINE AMBIGUOUS_MAPPING", () => {
    const result = classifyConflicts(row({ catalogTotal: 5 }), {
      ...BASE_CONTEXT,
      matchingMappingIds: ["mapping_1", "mapping_2"],
    })
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "AMBIGUOUS_MAPPING" })
  })

  // 14. reference recoding conocida no produce falso positivo. Caso F.
  // El caso real (567 falsos positivos, ver Etapa 2): Exel recodifica
  // supplier_internal_ref sin avisar, manteniendo el mismo supplierSku.
  // classifyConflicts() ni siquiera ve supplier_internal_ref -- el
  // resolvedor de mappingIds (fuera de esta función pura) ya debe resolver
  // por supplierSku, no por la referencia. Esta prueba demuestra que, con
  // el mapping ya resuelto (1 solo match) a pesar de que la referencia
  // cambió, el flujo sigue normal -- no hay ningún conflictType especial
  // de "referencia cambió" que bloquee.
  it("Caso F — referencia recodificada pero SKU resuelve a 1 solo mapping -> flujo normal, no un falso positivo", () => {
    const result = classifyConflicts(
      row({
        supplierSku: "3M2000",
        supplierReference: "XEAPAPAE002", // antes era XECPAPAE003 — ya no importa aquí
        catalogTotal: 7,
        warehouseReadings: [{ warehouseExternalCode: "MY", quantity: 7 }],
      }),
      { ...BASE_CONTEXT, matchingMappingIds: ["mapping_recoded"] }
    )
    expect(result.action).toEqual("APPLY")
  })

  // Fallo técnico (upstream) tiene prioridad y es su propio tipo.
  it("fallo de transporte en la consulta -> QUARANTINE UPSTREAM_ERROR", () => {
    const result = classifyConflicts(row({ catalogTotal: 5 }), {
      ...BASE_CONTEXT,
      upstreamError: true,
    })
    expect(result).toMatchObject({ action: "QUARANTINE", conflictType: "UPSTREAM_ERROR" })
  })

  it("duplicado de almacén con el MISMO valor no bloquea (solo discrepancias bloquean)", () => {
    const result = classifyConflicts(
      row({
        catalogTotal: 10,
        warehouseReadings: [
          { warehouseExternalCode: "MY", quantity: 10 },
          { warehouseExternalCode: "MY", quantity: 10 },
        ],
      }),
      BASE_CONTEXT
    )
    expect(result).toMatchObject({ action: "APPLY", reason: "CONFIRMED_WITH_LOCATIONS" })
  })
})

describe("classifyAbsentMappings — Caso real: mouse Logitech Pebble 2 M350s", () => {
  // Evidencia real (conflict_draft.php / inventory_reconciler.py, SSH
  // 2026-10-02): un producto que desaparece POR COMPLETO del feed del
  // proveedor (ninguna fila, ni siquiera stock=0) se queda congelado para
  // siempre si nadie lo visita explícitamente -- pasó 5+ semanas con 11
  // unidades mostradas después de desaparecer de Exel.
  it("un mapping conocido que no aparece en el snapshot de hoy se aplica en cero (si el snapshot es confiable)", () => {
    const result = classifyAbsentMappings(
      [{ mappingId: "mapping_logitech", supplierSku: "910-007047" }],
      new Set(["OTRO-SKU-1", "OTRO-SKU-2"]),
      /* snapshotRowCount */ 20,
      /* minimumCatalogSize */ 10
    )
    expect(result).toEqual([
      { mappingId: "mapping_logitech", supplierSku: "910-007047", reason: "ABSENT_FROM_CATALOG" },
    ])
  })

  it("snapshot sospechosamente pequeño/parcial -> no se asume ausencia real (salvaguarda real de producción)", () => {
    const result = classifyAbsentMappings(
      [{ mappingId: "mapping_logitech", supplierSku: "910-007047" }],
      new Set(),
      /* snapshotRowCount */ 3,
      /* minimumCatalogSize */ 10
    )
    expect(result).toEqual([])
  })
})

describe("nextQuarantineState — salida de cuarentena (regla corregida)", () => {
  // 16. primer run consistente incrementa contador a 1.
  it("primer run APPLY-compatible desde cuarentena incrementa el contador a 1 sin salir todavía", () => {
    const next = nextQuarantineState(
      { status: "quarantined", consecutiveConsistentRuns: 0 },
      { action: "APPLY", reason: "CONFIRMED_WITH_LOCATIONS", warehouseTotals: {}, resolvedTotal: 10 }
    )
    expect(next).toEqual({ status: "quarantined", consecutiveConsistentRuns: 1 })
  })

  // 17. segundo run consistente libera cuarentena.
  it("segundo run APPLY-compatible consecutivo libera la cuarentena", () => {
    const next = nextQuarantineState(
      { status: "quarantined", consecutiveConsistentRuns: 1 },
      { action: "APPLY", reason: "CONFIRMED_WITH_LOCATIONS", warehouseTotals: {}, resolvedTotal: 10 }
    )
    expect(next).toEqual({ status: "active", consecutiveConsistentRuns: 2 })
  })

  // 18. un run inconsistente entre ambos reinicia el contador.
  it("un QUARANTINE entre dos runs consistentes reinicia el contador a 0", () => {
    const afterFirst = nextQuarantineState(
      { status: "quarantined", consecutiveConsistentRuns: 0 },
      { action: "APPLY", reason: "CONFIRMED_WITH_LOCATIONS", warehouseTotals: {}, resolvedTotal: 10 }
    )
    const afterSecond = nextQuarantineState(afterFirst, {
      action: "QUARANTINE",
      conflictType: "TOTAL_WAREHOUSE_MISMATCH",
      reason: "x",
      supplierTotal: 90,
      warehouseTotal: 2,
    })
    expect(afterSecond).toEqual({ status: "quarantined", consecutiveConsistentRuns: 0 })
  })

  // 19. stock positivo pero inconsistente (Caso C) NO cuenta como consistente.
  it("Caso C (ambos positivos, mismatch) clasifica QUARANTINE y por lo tanto NO incrementa el contador", () => {
    const classification = classifyConflicts(
      {
        supplierSku: "SKU-C",
        catalogTotal: 90,
        warehouseReadings: [{ warehouseExternalCode: "MX", quantity: 2 }],
        knownWarehouseCodes: ["GD", "MX", "MY", "TR"],
      },
      BASE_CONTEXT
    )
    const next = nextQuarantineState(
      { status: "active", consecutiveConsistentRuns: 2 },
      classification
    )
    expect(next).toEqual({ status: "quarantined", consecutiveConsistentRuns: 0 })
  })
})

describe("deriveSyncRunFinalStatus — distingue fallo técnico de conflicto de negocio", () => {
  // 4. fallo técnico queda diferenciado de conflicto de negocio.
  it("todas las filas fallaron a nivel técnico -> failed", () => {
    expect(
      deriveSyncRunFinalStatus({ totalRows: 10, appliedCount: 0, quarantinedCount: 0, skippedCount: 0, errorCount: 10 })
    ).toEqual("failed")
  })

  it("hay conflictos de negocio pero el run funcionó -> completed_with_conflicts", () => {
    expect(
      deriveSyncRunFinalStatus({ totalRows: 10, appliedCount: 8, quarantinedCount: 2, skippedCount: 0, errorCount: 0 })
    ).toEqual("completed_with_conflicts")
  })

  it("todo aplicó sin problemas -> completed", () => {
    expect(
      deriveSyncRunFinalStatus({ totalRows: 10, appliedCount: 10, quarantinedCount: 0, skippedCount: 0, errorCount: 0 })
    ).toEqual("completed")
  })
})

describe("Guardrails de arquitectura", () => {
  // 20. no se modifica InventoryLevel. Ninguna función de reconciliación
  // conoce ni importa el módulo de Inventory de Medusa -- verificación
  // estática del código fuente, no solo una promesa en un comentario.
  it("ningún archivo de reconciliation/ importa el módulo de Inventory de Medusa", () => {
    const dir = path.join(__dirname, "..")
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !fs.statSync(path.join(dir, f)).isDirectory())
    const forbidden = /@medusajs\/(inventory|medusa\/inventory)|InventoryLevel|InventoryItemService/
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf-8")
      expect({ file, matches: forbidden.test(content) }).toEqual({ file, matches: false })
    }
  })

  // 21. tipos Exel crudos no llegan al reconciliation engine. Los campos
  // de ReconciliationRow son genéricos (ver types.ts); un fixture real de
  // Exel, al pasar por sus claves, nunca debe traer vocabulario de Exel.
  it("los fixtures golden (ya traducidos a vocabulario genérico) no contienen claves crudas de Exel", () => {
    const fixture = loadGolden("incidente-2026-09-16-conflicting-warehouse-values.json")
    const serialized = JSON.stringify(fixture.row)
    for (const exelTerm of ["clave_almacen", "clave_producto", "almacen_clave", "clave_transportista"]) {
      expect(serialized.includes(exelTerm)).toEqual(false)
    }
  })

  // 24. logs/audit no contienen secretos.
  it("los eventos de commerce-audit nunca incluyen campos que parezcan credenciales", () => {
    const emitter = new InMemoryCommerceAuditEmitter()
    emitter.emit({
      eventType: "STOCK_CONFLICT_DETECTED",
      correlationId: "corr_1",
      supplierId: "supplier_1",
      syncRunId: "run_1",
      details: { conflictType: "TOTAL_WAREHOUSE_MISMATCH", supplierTotal: 90, warehouseTotal: 2 },
      occurredAt: new Date(),
    })
    const sensitivePattern = /key|secret|token|password|credential/i
    for (const event of emitter.events) {
      const keys = Object.keys(event.details ?? {})
      expect(keys.filter((k) => sensitivePattern.test(k))).toEqual([])
    }
  })
})

describe("computeSourceSnapshotChecksum — identidad de SyncRun", () => {
  it("es determinista para el mismo contenido sin importar el orden de las filas", () => {
    const a = computeSourceSnapshotChecksum([
      { supplierSku: "B", catalogTotal: 2 },
      { supplierSku: "A", catalogTotal: 1 },
    ])
    const b = computeSourceSnapshotChecksum([
      { supplierSku: "A", catalogTotal: 1 },
      { supplierSku: "B", catalogTotal: 2 },
    ])
    expect(a).toEqual(b)
  })

  it("cambia si el contenido cambia", () => {
    const a = computeSourceSnapshotChecksum([{ supplierSku: "A", catalogTotal: 1 }])
    const b = computeSourceSnapshotChecksum([{ supplierSku: "A", catalogTotal: 2 }])
    expect(a).not.toEqual(b)
  })
})
