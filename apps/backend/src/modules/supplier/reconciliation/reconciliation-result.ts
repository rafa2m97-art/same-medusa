import type { ConflictType } from "./taxonomy"

/**
 * Contrato entre Reconciliation (Etapa 3) e Inventory (Etapa 4) — lo que el
 * motor de sync produce DESPUÉS de resolver `ConflictClassification` (que es
 * por-sku, sin ids reales) contra el dominio (mapping real, warehouses
 * reales). Inventory solo conoce esta forma, nunca `ConflictClassification`
 * ni nada de Exel.
 *
 * §7 (almacén ausente vs. stock 0) — DECISIÓN: `normalizedWarehouseLevels`
 * debe ser la lista COMPLETA de los `knownWarehouseCodes` del proveedor, ya
 * resuelta a `SupplierWarehouse` reales, cada uno con una `quantity`
 * explícita (nunca ausente) — exactamente lo que
 * `ConflictClassification.warehouseTotals` ya garantiza por construcción
 * (ver classify-conflicts.ts: se inicializan TODOS los knownWarehouseCodes
 * en 0 antes de sobreescribir con lecturas reales). Por eso la
 * responsabilidad de "completar huecos" vive en Reconciliation, no aquí:
 * Inventory nunca tiene que decidir qué hacer con un almacén "ausente"
 * porque, si este contrato se respeta, nunca lo está.
 */
export interface NormalizedWarehouseLevel {
  supplierWarehouseId: string
  quantity: number
}

export type ReconciliationResult =
  | {
      action: "APPLY"
      supplierProductMappingId: string
      syncRunId: string
      normalizedWarehouseLevels: NormalizedWarehouseLevel[]
    }
  | {
      action: "QUARANTINE"
      supplierProductMappingId: string
      syncRunId: string
      conflictType: ConflictType
    }
