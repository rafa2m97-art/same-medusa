/**
 * Pase de nivel de LOTE (no por fila) — equivalente genérico al bloque
 * "Productos del baseline con referencia AUSENTE del catálogo de HOY" de
 * inventory_reconciler.py (real, confirmado por SSH 2026-10-02).
 *
 * Caso real que motivó esto en producción: el mouse Logitech Pebble 2
 * M350s Blanco (referencia 910-007047) se quedó mostrando 11 unidades más
 * de 5 semanas después de desaparecer POR COMPLETO del feed de Exel — el
 * bucle principal de clasificación solo recorre skus presentes en el
 * snapshot de HOY, así que un producto que desaparece sin dejar ninguna
 * fila nunca se visita y su stock queda congelado para siempre.
 *
 * Por eso esto es una función separada: recibe los mappings que YA
 * conocíamos (de antes de este SyncRun) y el conjunto de skus presentes en
 * el snapshot de hoy, y decide cuáles deben APLICARSE EN CERO aunque no
 * hayan producido ningún ReconciliationRow.
 *
 * `minimumCatalogSize` reproduce la salvaguarda real (ABSENT_MIN_CATALOG_SIZE
 * = 5000 en producción): un snapshot parcial/roto (ej. Exel caído a medio
 * paginado) nunca debe interpretarse como "todo lo que falta se agotó".
 */

export interface KnownMapping {
  mappingId: string
  supplierSku: string
}

export interface AbsentMappingResult {
  mappingId: string
  supplierSku: string
  reason: "ABSENT_FROM_CATALOG"
}

export function classifyAbsentMappings(
  knownMappings: KnownMapping[],
  skusPresentInSnapshot: Set<string>,
  snapshotRowCount: number,
  minimumCatalogSize: number
): AbsentMappingResult[] {
  if (snapshotRowCount < minimumCatalogSize) {
    // Snapshot sospechosamente pequeño/parcial — no asumir que lo ausente
    // de verdad se agotó. Igual que la salvaguarda real.
    return []
  }

  return knownMappings
    .filter((m) => !skusPresentInSnapshot.has(m.supplierSku))
    .map((m) => ({
      mappingId: m.mappingId,
      supplierSku: m.supplierSku,
      reason: "ABSENT_FROM_CATALOG" as const,
    }))
}
