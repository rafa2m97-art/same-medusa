import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { SUPPLIER_MODULE } from "../index"

jest.setTimeout(60000)
import Supplier from "../models/supplier"
import SupplierWarehouse from "../models/supplier-warehouse"
import SupplierProductMapping from "../models/supplier-product-mapping"
import SupplierProductState from "../models/supplier-product-state"
import SyncRun from "../models/sync-run"
import SyncConflict from "../models/sync-conflict"
import SupplierModuleService from "../service"
import { classifyConflicts } from "../reconciliation/classify-conflicts"
import { deriveSyncRunFinalStatus } from "../reconciliation/sync-run-status"

moduleIntegrationTestRunner<SupplierModuleService>({
  moduleName: SUPPLIER_MODULE,
  resolve: __dirname + "/..",
  moduleModels: [
    Supplier,
    SupplierWarehouse,
    SupplierProductMapping,
    SupplierProductState,
    SyncRun,
    SyncConflict,
  ],
  testSuite: ({ service }) => {
    describe("Reconciliación — Etapa 3", () => {
      async function createSupplier(code: string) {
        return service.createSuppliers({ code, name: code, adapter_key: code })
      }

      // 1. SyncRun se crea correctamente.
      it("crea un SyncRun", async () => {
        const supplier = await createSupplier("sr_create")
        const run = await service.createSyncRuns({
          supplier_id: supplier.id,
          mode: "dry_run",
          status: "pending",
        })
        expect(run.id).toBeDefined()
        expect(run.mode).toEqual("dry_run")
        expect(run.status).toEqual("pending")
      })

      // 2. un sync puede finalizar sin conflictos.
      it("un SyncRun puede finalizar sin conflictos -> completed", async () => {
        const supplier = await createSupplier("sr_no_conflicts")
        const run = await service.createSyncRuns({
          supplier_id: supplier.id,
          mode: "dry_run",
          status: "running",
          started_at: new Date(),
          total_rows: 5,
        })
        const finalStatus = deriveSyncRunFinalStatus({
          totalRows: 5,
          appliedCount: 5,
          quarantinedCount: 0,
          skippedCount: 0,
          errorCount: 0,
        })
        const [updated] = await service.updateSyncRuns([
          {
            id: run.id,
            status: finalStatus,
            completed_at: new Date(),
            applied_count: 5,
          },
        ])
        expect(updated.status).toEqual("completed")
      })

      // 3. un sync puede finalizar con conflictos.
      it("un SyncRun puede finalizar con conflictos -> completed_with_conflicts", async () => {
        const supplier = await createSupplier("sr_with_conflicts")
        const run = await service.createSyncRuns({
          supplier_id: supplier.id,
          mode: "dry_run",
          status: "running",
          started_at: new Date(),
          total_rows: 5,
        })
        const finalStatus = deriveSyncRunFinalStatus({
          totalRows: 5,
          appliedCount: 3,
          quarantinedCount: 2,
          skippedCount: 0,
          errorCount: 0,
        })
        const [updated] = await service.updateSyncRuns([
          {
            id: run.id,
            status: finalStatus,
            completed_at: new Date(),
            applied_count: 3,
            quarantined_count: 2,
          },
        ])
        expect(updated.status).toEqual("completed_with_conflicts")
      })

      // 15. QUARANTINE crea/actualiza el estado operacional (SupplierProductState).
      it("un resultado QUARANTINE crea el SupplierProductState del mapping afectado", async () => {
        const supplier = await createSupplier("sr_state_create")
        const mapping = await service.createSupplierProductMappings({
          supplier_id: supplier.id,
          variant_id: "variant_state_1",
          supplier_sku: "SKU-STATE-1",
        })

        const classification = classifyConflicts(
          {
            supplierSku: "SKU-STATE-1",
            catalogTotal: 11,
            warehouseReadings: [{ warehouseExternalCode: "GD", quantity: 0 }],
            knownWarehouseCodes: ["GD", "MX", "MY", "TR"],
          },
          { matchingMappingIds: [mapping.id], isDuplicateReferenceInSnapshot: false, upstreamError: false }
        )
        expect(classification.action).toEqual("QUARANTINE")
        if (classification.action !== "QUARANTINE") return

        const state = await service.createSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
          status: "quarantined",
          reason: classification.conflictType,
          quarantined_since: new Date(),
          last_evaluated_at: new Date(),
          last_supplier_total: classification.supplierTotal,
          last_warehouse_total: classification.warehouseTotal,
          last_conflict_at: new Date(),
        })

        expect(state.status).toEqual("quarantined")
        expect(state.reason).toEqual("TOTAL_WAREHOUSE_MISMATCH")
        expect(state.supplier_product_mapping_id).toEqual(mapping.id)
      })

      it("una reconciliación posterior ACTUALIZA el SupplierProductState existente (no crea uno nuevo)", async () => {
        const supplier = await createSupplier("sr_state_update")
        const mapping = await service.createSupplierProductMappings({
          supplier_id: supplier.id,
          variant_id: "variant_state_2",
          supplier_sku: "SKU-STATE-2",
        })
        const state = await service.createSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
          status: "quarantined",
          reason: "TOTAL_WAREHOUSE_MISMATCH",
          consecutive_consistent_runs: 0,
        })

        const [updated] = await service.updateSupplierProductStates([
          {
            id: state.id,
            status: "active",
            reason: null,
            consecutive_consistent_runs: 2,
            last_apply_at: new Date(),
          },
        ])

        const all = await service.listSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
        })
        expect(all).toHaveLength(1)
        expect(updated.status).toEqual("active")
        expect(updated.consecutive_consistent_runs).toEqual(2)
      })

      // 23. SyncConflict guarda taxonomía estable + detalles.
      it("un SyncConflict guarda conflict_type estable y los detalles numéricos", async () => {
        const supplier = await createSupplier("sr_conflict_row")
        const run = await service.createSyncRuns({ supplier_id: supplier.id, mode: "dry_run" })
        const mapping = await service.createSupplierProductMappings({
          supplier_id: supplier.id,
          variant_id: "variant_conflict_1",
          supplier_sku: "SKU-CONFLICT-1",
        })

        const conflict = await service.createSyncConflicts({
          sync_run_id: run.id,
          supplier_product_mapping_id: mapping.id,
          supplier_sku: "SKU-CONFLICT-1",
          conflict_type: "TOTAL_WAREHOUSE_MISMATCH",
          reason: "catalog_total=90 no coincide con la suma por almacén=2.",
          supplier_total: 90,
          warehouse_total: 2,
          warehouse_breakdown: { GD: 0, MX: 2, MY: 0, TR: 0 },
          detected_at: new Date(),
        })

        const [reloaded] = await service.listSyncConflicts({ id: conflict.id })
        expect(reloaded.conflict_type).toEqual("TOTAL_WAREHOUSE_MISMATCH")
        expect(reloaded.supplier_total).toEqual(90)
        expect(reloaded.warehouse_total).toEqual(2)
        expect(reloaded.warehouse_breakdown).toEqual({ GD: 0, MX: 2, MY: 0, TR: 0 })
      })

      it("un SyncConflict puede existir SIN mapping (UNKNOWN_PRODUCT_MAPPING) — supplier_product_mapping_id nullable", async () => {
        const supplier = await createSupplier("sr_conflict_no_mapping")
        const run = await service.createSyncRuns({ supplier_id: supplier.id, mode: "dry_run" })

        const conflict = await service.createSyncConflicts({
          sync_run_id: run.id,
          supplier_sku: "SKU-UNMAPPED",
          conflict_type: "UNKNOWN_PRODUCT_MAPPING",
          reason: "Ningún SupplierProductMapping coincide.",
          detected_at: new Date(),
        })
        expect(conflict.supplier_product_mapping_id).toBeFalsy()
      })

      // 25. corrida duplicada/snapshot duplicado se maneja según estrategia definida.
      it("dos SyncRun con el mismo checksum para el mismo proveedor -> rechazado (unique constraint)", async () => {
        const supplier = await createSupplier("sr_dup_checksum")
        await service.createSyncRuns({
          supplier_id: supplier.id,
          mode: "dry_run",
          source_snapshot_checksum: "abc123",
        })

        await expect(
          service.createSyncRuns({
            supplier_id: supplier.id,
            mode: "dry_run",
            source_snapshot_checksum: "abc123",
          })
        ).rejects.toThrow()
      })

      it("el mismo checksum SÍ se permite para proveedores DISTINTOS", async () => {
        const supplierA = await createSupplier("sr_dup_checksum_a")
        const supplierB = await createSupplier("sr_dup_checksum_b")

        await service.createSyncRuns({
          supplier_id: supplierA.id,
          mode: "dry_run",
          source_snapshot_checksum: "same-checksum",
        })
        const runB = await service.createSyncRuns({
          supplier_id: supplierB.id,
          mode: "dry_run",
          source_snapshot_checksum: "same-checksum",
        })
        expect(runB.id).toBeDefined()
      })

      it("dos SyncRun SIN checksum (ej. capture_only) nunca chocan entre sí", async () => {
        const supplier = await createSupplier("sr_null_checksum")
        await service.createSyncRuns({ supplier_id: supplier.id, mode: "capture_only" })
        const second = await service.createSyncRuns({ supplier_id: supplier.id, mode: "capture_only" })
        expect(second.id).toBeDefined()
      })
    })
  },
})
