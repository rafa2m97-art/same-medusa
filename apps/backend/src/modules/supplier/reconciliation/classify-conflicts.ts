import type { ConflictClassification, ReconciliationContext, ReconciliationRow } from "./types"
import type { ApplyReason, ConflictType } from "./taxonomy"

/**
 * Decide APPLY o QUARANTINE para UN sku de proveedor en UN SyncRun. Función
 * pura: nada de I/O, nada de fechas/ids generados aquí (el llamador los
 * agrega al construir el SyncConflict). El orden de las reglas reproduce
 * deliberadamente la precedencia real de inventory_reconciler.py (ver
 * taxonomy.ts para la fuente exacta) — comentado caso por caso dónde se
 * sigue igual y dónde se decide diferente a propósito.
 */
export function classifyConflicts(
  row: ReconciliationRow,
  context: ReconciliationContext
): ConflictClassification {
  // --- Fallo técnico primero: no es un conflicto de datos. ---
  if (context.upstreamError) {
    return quarantine("UPSTREAM_ERROR", "La consulta a este sku falló a nivel de transporte (timeout/5xx/vacío) en este SyncRun.", row)
  }

  // --- Calidad de la fila misma (real: capture_reference.py / DUPLICATE_RESPONSE). ---
  if (context.isDuplicateReferenceInSnapshot) {
    return quarantine(
      "DUPLICATE_REFERENCE",
      "Este supplierSku aparece más de una vez como fila de nivel superior en el snapshot — no se puede saber cuál es la correcta.",
      row
    )
  }
  if (!row.supplierSku) {
    return quarantine("MISSING_SKU", "La fila no trae supplierSku.", row)
  }

  // --- Calidad del desglose por almacén (si existe). ---
  if (row.warehouseReadings !== null) {
    const unknown = row.warehouseReadings.find(
      (r) => !row.knownWarehouseCodes.includes(r.warehouseExternalCode)
    )
    if (unknown) {
      return quarantine(
        "UNKNOWN_WAREHOUSE",
        `Almacén "${unknown.warehouseExternalCode}" no está registrado para este proveedor.`,
        row
      )
    }
    const nonNumeric = row.warehouseReadings.find((r) => r.quantity === null)
    if (nonNumeric) {
      return quarantine(
        "NON_NUMERIC_QUANTITY",
        `Cantidad no numérica/no entera recibida para el almacén "${nonNumeric.warehouseExternalCode}".`,
        row
      )
    }
    const negative = row.warehouseReadings.find((r) => (r.quantity as number) < 0)
    if (negative) {
      return quarantine(
        "NEGATIVE_QUANTITY",
        `Cantidad negativa recibida para el almacén "${negative.warehouseExternalCode}".`,
        row
      )
    }

    // Evidencia real: 2284 productos afectados (Auditoria 2026-09-16,
    // hoja "Almacenes contradictorios") — el mismo almacén aparece más de
    // una vez para el mismo sku, con valores que pueden o no coincidir.
    // Solo bloquea si DISCREPAN; si son duplicados con el mismo valor se
    // deduplica en silencio (no hay evidencia real de que eso cause
    // incidentes — el riesgo real documentado es la discrepancia).
    const byWarehouse = new Map<string, Set<number>>()
    for (const r of row.warehouseReadings) {
      const set = byWarehouse.get(r.warehouseExternalCode) ?? new Set<number>()
      set.add(r.quantity as number)
      byWarehouse.set(r.warehouseExternalCode, set)
    }
    const conflicting = [...byWarehouse.entries()].find(([, values]) => values.size > 1)
    if (conflicting) {
      return quarantine(
        "CONFLICTING_WAREHOUSE_VALUES",
        `El almacén "${conflicting[0]}" trae valores distintos entre sí en la misma respuesta: ${[...conflicting[1]].join(",")}.`,
        row
      )
    }
  }

  // --- Mapeo SAME <-> proveedor. ---
  if (context.matchingMappingIds.length === 0) {
    return quarantine("UNKNOWN_PRODUCT_MAPPING", "Ningún SupplierProductMapping coincide con este supplierSku.", row)
  }
  if (context.matchingMappingIds.length > 1) {
    return quarantine(
      "AMBIGUOUS_MAPPING",
      `${context.matchingMappingIds.length} SupplierProductMapping distintos coinciden con este supplierSku.`,
      row
    )
  }

  // --- Ausencia de una de las dos fuentes (Caso E). ---
  if (row.catalogTotal === null) {
    return quarantine("MISSING_CATALOG_ROW", "El sku tiene desglose por almacén pero no apareció en la fuente de catálogo/totales.", row)
  }
  if (row.warehouseReadings === null) {
    return quarantine("MISSING_WAREHOUSE_BREAKDOWN", "El sku tiene total de catálogo pero no apareció en absoluto en la fuente de desglose por almacén.", row)
  }

  // --- Total vs. desglose por almacén (el núcleo real del problema de Exel). ---
  const warehouseTotals: Record<string, number> = {}
  for (const code of row.knownWarehouseCodes) warehouseTotals[code] = 0
  for (const r of row.warehouseReadings) {
    warehouseTotals[r.warehouseExternalCode] = r.quantity as number
  }
  const warehouseSum = Object.values(warehouseTotals).reduce((a, b) => a + b, 0)
  const catalogTotal = row.catalogTotal

  if (catalogTotal === 0 && warehouseSum === 0) {
    // Caso D — confirmado en cero en ambas fuentes. Real: CONFIRMED_ZERO.
    return apply("CONFIRMED_ZERO", warehouseTotals, 0)
  }

  if (catalogTotal === warehouseSum) {
    // Caso A — consistente. Real: CONFIRMED_WITH_LOCATIONS.
    return apply("CONFIRMED_WITH_LOCATIONS", warehouseTotals, catalogTotal)
  }

  // Caso B, su espejo, y Caso C (diferencia grande con ambos positivos)
  // caen todos aquí. DIFERENCIA DELIBERADA vs. producción real: hoy, si
  // ambos son positivos pero no coinciden (ej. 90 vs 2), el sistema real
  // APLICA usando catalog_total sin cuarentena (ver taxonomy.ts) — aquí
  // SIEMPRE se manda a QUARANTINE, sin excepción por "ambos positivos".
  return quarantine(
    "TOTAL_WAREHOUSE_MISMATCH",
    `catalog_total=${catalogTotal} no coincide con la suma por almacén=${warehouseSum}.`,
    row,
    warehouseTotals
  )
}

function apply(
  reason: ApplyReason,
  warehouseTotals: Record<string, number>,
  resolvedTotal: number
): ConflictClassification {
  return { action: "APPLY", reason, warehouseTotals, resolvedTotal }
}

function quarantine(
  conflictType: ConflictType,
  reason: string,
  row: ReconciliationRow,
  warehouseBreakdown?: Record<string, number>
): ConflictClassification {
  return {
    action: "QUARANTINE",
    conflictType,
    reason,
    supplierTotal: row.catalogTotal,
    warehouseTotal:
      row.warehouseReadings === null
        ? null
        : row.warehouseReadings.reduce((sum, r) => sum + (r.quantity ?? 0), 0),
    warehouseBreakdown,
  }
}
