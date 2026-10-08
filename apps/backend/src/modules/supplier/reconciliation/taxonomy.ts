/**
 * Taxonomía de reconciliación — NO inventada: reconstruida directamente del
 * código real en producción (VPS, verificado 2026-10-02 vía SSH):
 *   - /opt/exel_sync/msl_final/lib/classification/inventory_reconciler.py
 *   - /opt/exel_sync/msl_final/conflict_draft.php
 *   - /opt/exel_sync/msl_final/lib/capture/capture_reference.py
 *   - Auditoria_Inconsistencias_API_Exel_2026-09-16.xlsx (evidencia numérica)
 *
 * Términos tomados TAL CUAL del código/auditoría real:
 *   CONFLICTING_WAREHOUSE_VALUES, TOTAL_WAREHOUSE_MISMATCH,
 *   AMBIGUOUS_MAPPING (real: WOO_MAPPING_AMBIGUOUS), UPSTREAM_ERROR,
 *   DUPLICATE_WAREHOUSE_ROW, INVALID_DATA, CONFIRMED_WITH_LOCATIONS,
 *   CONFIRMED_ZERO, ABSENT_FROM_CATALOG.
 *
 * Términos RENOMBRADOS a propósito (de WooCommerce-específico a genérico de
 * dominio, documentado en cada caso en classify-conflicts.ts):
 *   WOO_PRODUCT_NOT_FOUND -> UNKNOWN_PRODUCT_MAPPING
 *   WOO_MAPPING_AMBIGUOUS -> AMBIGUOUS_MAPPING
 *
 * Deliberadamente NO portado (específico de WordPress/WooCommerce, sin
 * equivalente real en el dominio Medusa — ver reporte de Etapa 3):
 *   UNSUPPORTED_PRODUCT_TYPE (post_type product vs product_variation).
 *
 * MEJORA deliberada sobre el comportamiento real actual (documentada en
 * classify-conflicts.ts junto a la regla): hoy, cuando catalog_total y la
 * suma de almacenes son AMBOS positivos pero no coinciden (ej. 90 vs 2), el
 * sistema real APLICA usando el total del catálogo sin cuarentena — nunca
 * escala el blocker TOTAL_WAREHOUSE_MISMATCH que sí registra en su propia
 * auditoría (124 productos reales afectados, ver xlsx). Aquí SIEMPRE se
 * manda a QUARANTINE.
 */

export const CONFLICT_TYPES = [
  "MISSING_SKU",
  "DUPLICATE_REFERENCE",
  "UNKNOWN_WAREHOUSE",
  "NEGATIVE_QUANTITY",
  "NON_NUMERIC_QUANTITY",
  "DUPLICATE_WAREHOUSE_ROW",
  "CONFLICTING_WAREHOUSE_VALUES",
  "UNKNOWN_PRODUCT_MAPPING",
  "AMBIGUOUS_MAPPING",
  "MISSING_CATALOG_ROW",
  "MISSING_WAREHOUSE_BREAKDOWN",
  "TOTAL_WAREHOUSE_MISMATCH",
  "UPSTREAM_ERROR",
  "INVALID_DATA",
] as const

export type ConflictType = (typeof CONFLICT_TYPES)[number]

export const APPLY_REASONS = [
  "CONFIRMED_WITH_LOCATIONS",
  "CONFIRMED_ZERO",
  "ABSENT_FROM_CATALOG",
] as const

export type ApplyReason = (typeof APPLY_REASONS)[number]
