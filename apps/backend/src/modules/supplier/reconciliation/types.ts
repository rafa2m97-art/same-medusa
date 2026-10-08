import type { ApplyReason, ConflictType } from "./taxonomy"

/**
 * Una lectura cruda de almacén para un SKU, DENTRO de una sola respuesta del
 * proveedor. Deliberadamente no deduplicada antes de llegar aquí — Exel
 * puede devolver el mismo almacén más de una vez para el mismo SKU, con
 * valores que coinciden o no (evidencia real: 2284 productos afectados,
 * Auditoria_Inconsistencias_API_Exel_2026-09-16.xlsx, hoja "Almacenes
 * contradictorios"). classify-conflicts.ts es quien decide si eso bloquea.
 */
export interface WarehouseReading {
  warehouseExternalCode: string
  /** null si el valor crudo no es numérico/entero — ver NON_NUMERIC_QUANTITY. */
  quantity: number | null
}

/**
 * Entrada normalizada para UN sku de proveedor en UN SyncRun. "Normalizada"
 * no significa "limpia" — significa vocabulario genérico de dominio (nunca
 * nombres de campo de Exel), igual que el resto de DTOs de Etapa 2. Mantiene
 * duplicados/nulos a propósito: la limpieza ES el trabajo de
 * classifyConflicts(), no de la capa de normalización.
 */
export interface ReconciliationRow {
  supplierSku: string
  supplierReference?: string
  /** null = el sku no apareció en absoluto en la fuente de catálogo/totales (Caso E). */
  catalogTotal: number | null
  /** null = el sku no apareció en absoluto en la fuente de desglose por almacén (Caso E, espejo). */
  warehouseReadings: WarehouseReading[] | null
  /** Códigos de almacén válidos conocidos para ESTE proveedor (scoped — nunca una constante global). */
  knownWarehouseCodes: string[]
}

/** Lo que ya sabe el dominio SAME sobre este sku ANTES de reconciliar — el contexto que classifyConflicts() necesita pero no puede inferir de la fila sola. */
export interface ReconciliationContext {
  /** 0 = sin mapping, 1 = normal, >1 = ambiguo. */
  matchingMappingIds: string[]
  /** true si este mismo supplierSku aparece más de una vez como fila de nivel superior en el snapshot completo (no solo duplicado de almacén dentro de una fila). */
  isDuplicateReferenceInSnapshot: boolean
  /** true si la llamada que debía traer este sku falló a nivel de transporte (timeout/5xx/vacío) — no es un conflicto de datos, es un fallo técnico. */
  upstreamError: boolean
}

export type ConflictClassification =
  | {
      action: "APPLY"
      reason: ApplyReason
      /** Totales por almacén ya deduplicados/limpios — lo que Etapa 4 aplicaría. */
      warehouseTotals: Record<string, number>
      resolvedTotal: number
    }
  | {
      action: "QUARANTINE"
      conflictType: ConflictType
      reason: string
      supplierTotal: number | null
      warehouseTotal: number | null
      warehouseBreakdown?: Record<string, number>
    }
