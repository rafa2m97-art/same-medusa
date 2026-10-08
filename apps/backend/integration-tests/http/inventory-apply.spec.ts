import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { asValue } from "@medusajs/framework/awilix"
import { SUPPLIER_MODULE } from "../../src/modules/supplier"
import type SupplierModuleService from "../../src/modules/supplier/service"
import { createSupplierProductMappingWorkflow } from "../../src/modules/supplier/workflows/create-supplier-product-mapping"
import { relinkSupplierProductMappingVariantWorkflow } from "../../src/modules/supplier/workflows/relink-supplier-product-mapping-variant"
import { ensureStockLocationForWarehouseWorkflow } from "../../src/modules/supplier/workflows/ensure-stock-location-for-warehouse"
import { ensureInventoryItemForVariantWorkflow } from "../../src/modules/supplier/workflows/ensure-inventory-item-for-variant"
import { applyReconciledInventoryWorkflow } from "../../src/modules/supplier/workflows/apply-reconciled-inventory"
import { classifyConflicts } from "../../src/modules/supplier/reconciliation/classify-conflicts"
import { nextQuarantineState } from "../../src/modules/supplier/reconciliation/quarantine-state"
import {
  COMMERCE_AUDIT_EMITTER,
  InMemoryCommerceAuditEmitter,
} from "../../src/modules/commerce-audit/events"
import type { ReconciliationResult } from "../../src/modules/supplier/reconciliation/reconciliation-result"

jest.setTimeout(300000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const container = () => getContainer()

    async function createVariant(title: string, sku?: string) {
      const productService = container().resolve(Modules.PRODUCT)
      const [product] = await productService.createProducts([
        { title: `Product ${title}`, status: "draft" },
      ])
      const [variant] = await productService.createProductVariants([
        { title, sku: sku ?? title, product_id: product.id },
      ])
      return variant.id as string
    }

    async function createSupplier(code: string) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSuppliers({ code, name: code, adapter_key: code })
    }

    async function createWarehouse(supplierId: string, externalCode: string, name: string) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSupplierWarehouses({
        supplier_id: supplierId,
        external_code: externalCode,
        name,
      })
    }

    async function createMappingViaWorkflow(supplierId: string, variantId: string, sku: string) {
      const { result } = await createSupplierProductMappingWorkflow(container()).run({
        input: { supplier_id: supplierId, variant_id: variantId, supplier_sku: sku },
      })
      return result
    }

    async function getLinkedVariantIdForMapping(mappingId: string): Promise<string | null> {
      const link = container().resolve(ContainerRegistrationKeys.LINK)
      // Columna real del pivot (verificado contra la BD real):
      // product_variant_id -- NO "variant_id" (ese nombre corto es solo
      // del link NATIVO Product<->Inventory; nuestro link custom usa el
      // nombre completo de la entidad, product_variant_id).
      const links = await link.list(
        {
          [Modules.PRODUCT]: { product_variant_id: { $ne: null } },
          [SUPPLIER_MODULE]: { supplier_product_mapping_id: mappingId },
        },
        {}
      )
      return links.length > 0 ? ((links[0] as any).product_variant_id as string) : null
    }

    async function createSyncRun(supplierId: string, startedAt: Date) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSyncRuns({
        supplier_id: supplierId,
        mode: "dry_run",
        status: "running",
        started_at: startedAt,
      })
    }

    async function getInventoryLevel(variantId: string, locationId: string) {
      const link = container().resolve(ContainerRegistrationKeys.LINK)
      const itemLinks = await link.list(
        { [Modules.PRODUCT]: { variant_id: variantId }, [Modules.INVENTORY]: { inventory_item_id: { $ne: null } } },
        {}
      )
      const inventoryItemId = (itemLinks[0] as any).inventory_item_id as string
      const inventoryService = container().resolve(Modules.INVENTORY)
      const [level] = await inventoryService.listInventoryLevels({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
      })
      return level
    }

    describe("Etapa 3 (deuda técnica) — consistencia variant_id <-> Module Link", () => {
      it("crear un SupplierProductMapping vía workflow crea también el Module Link correcto", async () => {
        const supplier = await createSupplier("link_create_ok")
        const variantId = await createVariant("Variant Link Create OK")
        const mapping = await createMappingViaWorkflow(supplier.id, variantId, "SKU-LINK-1")

        const linkedVariantId = await getLinkedVariantIdForMapping(mapping.id)
        expect(linkedVariantId).toEqual(variantId)
        expect(mapping.variant_id).toEqual(variantId)
      })

      it("si falla la creación del Link, el mapping se revierte (compensación real)", async () => {
        const supplier = await createSupplier("link_create_fail")
        const variantId = await createVariant("Variant Link Create Fail")
        const link = container().resolve(ContainerRegistrationKeys.LINK)
        // mockRejectedValue (no "...Once"): el motor de Workflows puede
        // reintentar un step fallido — un solo "Once" se consume en el
        // reintento y el workflow terminaría pasando de largo.
        const createSpy = jest.spyOn(link, "create").mockRejectedValue(new Error("boom"))

        // try/finally: si la aserción de abajo fallara, el mock JAMÁS debe
        // quedar pegado al servicio compartido por el resto de la suite
        // (ya nos pasó: un mockRestore() que nunca se alcanza rompe TODOS
        // los tests siguientes que crean un Link real).
        //
        // No se afirma `.rejects.toThrow()` sobre `.run()` -- el motor de
        // Workflows puede terminar la transacción en REVERTED (compensación
        // ya ejecutada de verdad) sin volver a lanzar el error al caller
        // (ver originalExecution/isRegisterStepFailure en
        // @medusajs/workflows-sdk). Lo que importa comprobar es el efecto
        // real de la compensación, no la forma de la promesa.
        try {
          await createSupplierProductMappingWorkflow(container())
            .run({
              input: { supplier_id: supplier.id, variant_id: variantId, supplier_sku: "SKU-LINK-FAIL" },
            })
            .catch(() => {})
        } finally {
          createSpy.mockRestore()
        }

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const mappings = await supplierService.listSupplierProductMappings({
          supplier_id: supplier.id,
          supplier_sku: "SKU-LINK-FAIL",
        })
        expect(mappings).toHaveLength(0)
      })

      it("relinkear una variante actualiza AMBOS lados (variant_id y el Link)", async () => {
        const supplier = await createSupplier("relink_ok")
        const variantA = await createVariant("Variant A (relink)")
        const variantB = await createVariant("Variant B (relink)")
        const mapping = await createMappingViaWorkflow(supplier.id, variantA, "SKU-RELINK-1")

        await relinkSupplierProductMappingVariantWorkflow(container()).run({
          input: { mapping_id: mapping.id, previous_variant_id: variantA, new_variant_id: variantB },
        })

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const updated = await supplierService.retrieveSupplierProductMapping(mapping.id)
        const linkedVariantId = await getLinkedVariantIdForMapping(mapping.id)

        expect(updated.variant_id).toEqual(variantB)
        expect(linkedVariantId).toEqual(variantB)
      })

      it("nunca queda un estado donde variant_id y el Link apunten a variantes distintas (tras crear + relinkear)", async () => {
        const supplier = await createSupplier("no_divergence")
        const variantA = await createVariant("Variant A (no divergence)")
        const variantB = await createVariant("Variant B (no divergence)")
        const mapping = await createMappingViaWorkflow(supplier.id, variantA, "SKU-NODIV-1")

        await relinkSupplierProductMappingVariantWorkflow(container()).run({
          input: { mapping_id: mapping.id, previous_variant_id: variantA, new_variant_id: variantB },
        })

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const final = await supplierService.retrieveSupplierProductMapping(mapping.id)
        const linkedVariantId = await getLinkedVariantIdForMapping(mapping.id)
        expect(final.variant_id).toEqual(linkedVariantId)
      })
    })

    describe("Etapa 4, §1-§2 — SupplierWarehouse <-> StockLocation", () => {
      it("1. crea y vincula un StockLocation nuevo para un SupplierWarehouse", async () => {
        const supplier = await createSupplier("wh_sloc_create")
        const warehouse = await createWarehouse(supplier.id, "MY", "Monterrey")

        const { result } = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouse.id, desiredName: "EXEL del Norte - Monterrey" },
        })

        expect(result.created).toEqual(true)
        const stockLocationService = container().resolve(Modules.STOCK_LOCATION)
        const [location] = await stockLocationService.listStockLocations({ id: result.stockLocationId })
        expect(location.name).toEqual("EXEL del Norte - Monterrey")
      })

      it("2. el workflow es idempotente — llamarlo 2 veces no crea StockLocations duplicados", async () => {
        const supplier = await createSupplier("wh_sloc_idempotent")
        const warehouse = await createWarehouse(supplier.id, "MX", "Ciudad de México")

        const first = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouse.id, desiredName: "EXEL - CDMX" },
        })
        const second = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouse.id, desiredName: "EXEL - CDMX" },
        })

        expect(second.result.created).toEqual(false)
        expect(second.result.stockLocationId).toEqual(first.result.stockLocationId)

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const links = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouse.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        expect(links).toHaveLength(1)
      })

      it("renombra el StockLocation existente in-place si el warehouse cambia de nombre visible", async () => {
        const supplier = await createSupplier("wh_sloc_rename")
        const warehouse = await createWarehouse(supplier.id, "GD", "Guadalajara")

        const first = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouse.id, desiredName: "EXEL - Guadalajara (viejo)" },
        })
        const second = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouse.id, desiredName: "EXEL - Guadalajara (nuevo)" },
        })

        expect(second.result.stockLocationId).toEqual(first.result.stockLocationId)
        expect(second.result.renamed).toEqual(true)

        const stockLocationService = container().resolve(Modules.STOCK_LOCATION)
        const [location] = await stockLocationService.listStockLocations({ id: first.result.stockLocationId })
        expect(location.name).toEqual("EXEL - Guadalajara (nuevo)")
      })

      it("3. warehouse codes iguales de suppliers distintos generan StockLocations INDEPENDIENTES", async () => {
        const supplierA = await createSupplier("wh_sloc_multi_a")
        const supplierB = await createSupplier("wh_sloc_multi_b")
        const warehouseA = await createWarehouse(supplierA.id, "MX", "México (A)")
        const warehouseB = await createWarehouse(supplierB.id, "MX", "México (B)")

        const resultA = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouseA.id, desiredName: "A - México" },
        })
        const resultB = await ensureStockLocationForWarehouseWorkflow(container()).run({
          input: { supplierWarehouseId: warehouseB.id, desiredName: "B - México" },
        })

        expect(resultA.result.stockLocationId).not.toEqual(resultB.result.stockLocationId)
      })
    })

    describe("Etapa 4, §3 — ProductVariant <-> InventoryItem (nativo)", () => {
      it("4. una ProductVariant usa el InventoryItem nativo vía Module Link (no un modelo custom)", async () => {
        const variantId = await createVariant("Variant Inventory Native")
        const { result } = await ensureInventoryItemForVariantWorkflow(container()).run({
          input: { variantId },
        })
        expect(result.created).toEqual(true)

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const links = await link.list(
          { [Modules.PRODUCT]: { variant_id: variantId }, [Modules.INVENTORY]: { inventory_item_id: { $ne: null } } },
          {}
        )
        expect(links).toHaveLength(1)
        expect((links[0] as any).inventory_item_id).toEqual(result.inventoryItemId)
      })

      it("5. ensureInventoryItemForVariant es idempotente", async () => {
        const variantId = await createVariant("Variant Inventory Idempotent")
        const first = await ensureInventoryItemForVariantWorkflow(container()).run({ input: { variantId } })
        const second = await ensureInventoryItemForVariantWorkflow(container()).run({ input: { variantId } })

        expect(second.result.created).toEqual(false)
        expect(second.result.inventoryItemId).toEqual(first.result.inventoryItemId)
      })
    })

    describe("Etapa 4, §4-§9 — applyReconciledInventoryWorkflow (APPLY -> Inventory)", () => {
      async function setupMappingWithWarehouses() {
        const supplier = await createSupplier(`apply_${Date.now()}_${Math.random().toString(36).slice(2)}`)
        const warehouseMY = await createWarehouse(supplier.id, "MY", "Monterrey")
        const warehouseMX = await createWarehouse(supplier.id, "MX", "México")
        const variantId = await createVariant(`Variant ${supplier.id}`)
        const mapping = await createMappingViaWorkflow(supplier.id, variantId, "SKU-APPLY-1")
        return { supplier, warehouseMY, warehouseMX, variantId, mapping }
      }

      it("6. y 11. APPLY con múltiples almacenes actualiza InventoryLevel correctamente en cada StockLocation", async () => {
        const { supplier, warehouseMY, warehouseMX, variantId, mapping } = await setupMappingWithWarehouses()
        const syncRun = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        const result: ReconciliationResult = {
          action: "APPLY",
          supplierProductMappingId: mapping.id,
          syncRunId: syncRun.id,
          normalizedWarehouseLevels: [
            { supplierWarehouseId: warehouseMY.id, quantity: 4 },
            { supplierWarehouseId: warehouseMX.id, quantity: 6 },
          ],
        }

        const { result: applyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: { result },
        })
        expect(applyResult.proceed).toEqual(true)

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const whLinks = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: [warehouseMY.id, warehouseMX.id] }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const locationIdByWarehouse = new Map(
          whLinks.map((l: any) => [l.supplier_warehouse_id, l.stock_location_id])
        )

        const levelMY = await getInventoryLevel(variantId, locationIdByWarehouse.get(warehouseMY.id))
        const levelMX = await getInventoryLevel(variantId, locationIdByWarehouse.get(warehouseMX.id))
        expect(Number(levelMY.stocked_quantity)).toEqual(4)
        expect(Number(levelMX.stocked_quantity)).toEqual(6)

        // 16. los InventoryLevel están vinculados a las StockLocations correctas.
        expect(levelMY.location_id).toEqual(locationIdByWarehouse.get(warehouseMY.id))
        expect(levelMX.location_id).toEqual(locationIdByWarehouse.get(warehouseMX.id))
      })

      it("7. el mismo APPLY ejecutado dos veces produce exactamente el mismo resultado (absoluto, no incremental)", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const syncRun1 = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        const makeResult = (syncRunId: string): ReconciliationResult => ({
          action: "APPLY",
          supplierProductMappingId: mapping.id,
          syncRunId,
          normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 5 }],
        })

        await applyReconciledInventoryWorkflow(container()).run({ input: { result: makeResult(syncRun1.id) } })

        // Nota: un segundo apply con el MISMO syncRun sería rechazado por
        // stale (started_at igual) — eso se prueba aparte. Para probar
        // "correr el mismo snapshot dos veces da el mismo resultado" sin
        // chocar con el guard de staleness, se simula un SEGUNDO SyncRun
        // más nuevo que trae el MISMO valor (5) — el punto es que
        // stocked_quantity no se duplica/suma (5 -> 5, nunca 5+5=10).
        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T11:00:00Z"))
        await applyReconciledInventoryWorkflow(container()).run({ input: { result: makeResult(syncRun2.id) } })

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const level = await getInventoryLevel(variantId, (whLink as any).stock_location_id)
        expect(Number(level.stocked_quantity)).toEqual(5)
      })

      it("8. stock 0 se escribe correctamente (no se interpreta como ausencia/no-actualizar)", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const syncRun = await createSyncRun(supplier.id, new Date())

        const result: ReconciliationResult = {
          action: "APPLY",
          supplierProductMappingId: mapping.id,
          syncRunId: syncRun.id,
          normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 0 }],
        }
        await applyReconciledInventoryWorkflow(container()).run({ input: { result } })

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const level = await getInventoryLevel(variantId, (whLink as any).stock_location_id)
        expect(level).toBeDefined()
        expect(Number(level.stocked_quantity)).toEqual(0)
      })

      it("9. y 10. QUARANTINE no modifica InventoryLevel — el último inventario válido se conserva", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const syncRun1 = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun1.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 5 }],
            },
          },
        })

        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T11:00:00Z"))
        const { result: applyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "QUARANTINE",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun2.id,
              conflictType: "TOTAL_WAREHOUSE_MISMATCH",
            },
          },
        })
        expect(applyResult.proceed).toEqual(false)
        expect(applyResult.skipReason).toEqual("not_apply")

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const level = await getInventoryLevel(variantId, (whLink as any).stock_location_id)
        expect(Number(level.stocked_quantity)).toEqual(5)
      })

      it("mientras el mapping SIGA quarantined, un run individual APPLY tampoco actualiza Inventory (Last Known Good real)", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)

        const syncRun1 = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))
        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun1.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 5 }],
            },
          },
        })

        // El mapping entra en cuarentena (ej. run de catalog=90 vs almacén=2).
        // El primer APPLY de arriba ya creó un SupplierProductState (ver
        // markSupplierProductStateAppliedStep) -- hay que actualizarlo, no
        // crear uno nuevo (violaría el unique de supplier_product_mapping_id).
        const [existingState] = await supplierService.listSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
        })
        await supplierService.updateSupplierProductStates([
          {
            id: existingState.id,
            status: "quarantined",
            reason: "TOTAL_WAREHOUSE_MISMATCH",
            consecutive_consistent_runs: 0,
          },
        ])

        // Un run POSTERIOR, individualmente "consistente" (APPLY), mientras
        // sigue quarantined -> NO debe tocar Inventory todavía.
        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T12:00:00Z"))
        const { result: applyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun2.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 999 }],
            },
          },
        })
        expect(applyResult.proceed).toEqual(false)
        expect(applyResult.skipReason).toEqual("still_quarantined")

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const level = await getInventoryLevel(variantId, (whLink as any).stock_location_id)
        expect(Number(level.stocked_quantity)).toEqual(5)
      })

      it("13. un SyncRun más viejo que el último aplicado no sobreescribe el valor más nuevo", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const olderRun = await createSyncRun(supplier.id, new Date("2026-10-02T09:00:00Z"))
        const newerRun = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        // El run MÁS NUEVO se aplica primero (llega antes por timing real).
        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: newerRun.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 3 }],
            },
          },
        })

        // El run VIEJO termina después -> debe ser rechazado como stale.
        const { result: staleResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: olderRun.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 5 }],
            },
          },
        })
        expect(staleResult.proceed).toEqual(false)
        expect(staleResult.skipReason).toEqual("stale_sync_run")

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const level = await getInventoryLevel(variantId, (whLink as any).stock_location_id)
        expect(Number(level.stocked_quantity)).toEqual(3)
      })

      it("14. SupplierProductMapping inactivo no actualiza inventario", async () => {
        const { supplier, warehouseMY, mapping } = await setupMappingWithWarehouses()
        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        await supplierService.updateSupplierProductMappings([{ id: mapping.id, status: "inactive" }])
        const syncRun = await createSyncRun(supplier.id, new Date())

        const { result: applyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 9 }],
            },
          },
        })
        expect(applyResult.proceed).toEqual(false)
        expect(applyResult.skipReason).toEqual("inactive_mapping")
      })

      it("15. SupplierWarehouse inactivo se excluye, pero los demás almacenes activos SÍ se aplican", async () => {
        const { supplier, warehouseMY, warehouseMX, variantId, mapping } = await setupMappingWithWarehouses()
        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        await supplierService.updateSupplierWarehouses([{ id: warehouseMX.id, status: "inactive" }])
        const syncRun = await createSyncRun(supplier.id, new Date())

        const { result: applyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun.id,
              normalizedWarehouseLevels: [
                { supplierWarehouseId: warehouseMY.id, quantity: 7 },
                { supplierWarehouseId: warehouseMX.id, quantity: 100 },
              ],
            },
          },
        })
        expect(applyResult.proceed).toEqual(true)
        expect(applyResult.levelsApplied).toHaveLength(1)

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLinkMY] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const levelMY = await getInventoryLevel(variantId, (whLinkMY as any).stock_location_id)
        expect(Number(levelMY.stocked_quantity)).toEqual(7)

        // MX nunca se vinculó/escribió — nunca se le ensure-ó un StockLocation.
        const whLinksMX = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMX.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        expect(whLinksMX).toHaveLength(0)
      })

      it("17. y 18. multi-proveedor: EXEL no pisa los niveles de otro proveedor para la misma variante", async () => {
        const supplierExel = await createSupplier("multi_exel")
        const supplierCva = await createSupplier("multi_cva")
        const whExelMY = await createWarehouse(supplierExel.id, "MY", "Monterrey (Exel)")
        const whCvaMty = await createWarehouse(supplierCva.id, "MTY", "Monterrey (CVA)")
        const variantId = await createVariant("Variant Multi-Supplier")
        const mappingExel = await createMappingViaWorkflow(supplierExel.id, variantId, "SKU-EXEL-1")
        const mappingCva = await createMappingViaWorkflow(supplierCva.id, variantId, "SKU-CVA-1")

        const runExel = await createSyncRun(supplierExel.id, new Date("2026-10-02T10:00:00Z"))
        const runCva = await createSyncRun(supplierCva.id, new Date("2026-10-02T10:00:00Z"))

        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mappingExel.id,
              syncRunId: runExel.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: whExelMY.id, quantity: 5 }],
            },
          },
        })
        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mappingCva.id,
              syncRunId: runCva.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: whCvaMty.id, quantity: 10 }],
            },
          },
        })

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLinkExel] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: whExelMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const [whLinkCva] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: whCvaMty.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const levelExel = await getInventoryLevel(variantId, (whLinkExel as any).stock_location_id)
        const levelCva = await getInventoryLevel(variantId, (whLinkCva as any).stock_location_id)

        expect(Number(levelExel.stocked_quantity)).toEqual(5)
        expect(Number(levelCva.stocked_quantity)).toEqual(10)
        // Dos StockLocations distintas para la misma variante -> Medusa
        // agrega 15 "disponibles" a nivel de InventoryItem (ver §17 del
        // reporte: aggregate availability != fulfillment feasibility).
      })

      it("19. y 20. las reservas nativas no se destruyen al actualizar stocked_quantity; available = stocked - reserved", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const syncRun1 = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun1.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 10 }],
            },
          },
        })

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const itemLinks = await link.list(
          { [Modules.PRODUCT]: { variant_id: variantId }, [Modules.INVENTORY]: { inventory_item_id: { $ne: null } } },
          {}
        )
        const inventoryItemId = (itemLinks[0] as any).inventory_item_id as string
        const locationId = (whLink as any).stock_location_id as string

        const inventoryService = container().resolve(Modules.INVENTORY)
        await inventoryService.createReservationItems([
          { inventory_item_id: inventoryItemId, location_id: locationId, quantity: 2 },
        ])

        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T11:00:00Z"))
        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun2.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 7 }],
            },
          },
        })

        const [level] = await inventoryService.listInventoryLevels({
          inventory_item_id: inventoryItemId,
          location_id: locationId,
        })
        expect(Number(level.stocked_quantity)).toEqual(7)
        expect(Number(level.reserved_quantity)).toEqual(2)
        expect(Number(level.available_quantity)).toEqual(5)
      })

      it("21. una variante nueva usa la configuración nativa de SAME por defecto: manage_inventory=true, allow_backorder=false", async () => {
        const productService = container().resolve(Modules.PRODUCT)
        const [product] = await productService.createProducts([
          { title: "Product Overselling Defaults", status: "draft" },
        ])
        const [variant] = await productService.createProductVariants([
          { title: "Variant Overselling Defaults", product_id: product.id },
        ])
        expect(variant.manage_inventory).toEqual(true)
        expect(variant.allow_backorder).toEqual(false)
      })

      it("22. trazabilidad: SupplierProductState recuerda de qué SyncRun vino el inventario aplicado", async () => {
        const { supplier, warehouseMY, mapping } = await setupMappingWithWarehouses()
        const syncRun = await createSyncRun(supplier.id, new Date())

        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 1 }],
            },
          },
        })

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const [state] = await supplierService.listSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
        })
        expect(state.last_applied_sync_run_id).toEqual(syncRun.id)
        expect(state.last_apply_at).toBeTruthy()
      })

      it("23. el evento de auditoría INVENTORY_LEVEL_CHANGED contiene before/after correctos", async () => {
        const { supplier, warehouseMY, mapping } = await setupMappingWithWarehouses()
        const syncRun1 = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))
        const emitter = new InMemoryCommerceAuditEmitter()
        // El emitter se inyecta por el contenedor DI (no por workflow input
        // -- el motor de Workflows serializa el input entre steps y una
        // instancia de clase perdería sus métodos, ver commerce-audit-events.ts).
        container().register({ [COMMERCE_AUDIT_EMITTER]: asValue(emitter) })

        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun1.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 7 }],
            },
          },
        })

        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T11:00:00Z"))
        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun2.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 4 }],
            },
          },
        })

        const changeEvents = emitter.events.filter((e) => e.eventType === "INVENTORY_LEVEL_CHANGED")
        expect(changeEvents.length).toBeGreaterThanOrEqual(1)
        const last = changeEvents[changeEvents.length - 1]
        expect(last.details).toMatchObject({ before: 7, after: 4 })

        expect(emitter.events.some((e) => e.eventType === "INVENTORY_APPLY_STARTED")).toEqual(true)
        expect(emitter.events.some((e) => e.eventType === "INVENTORY_APPLY_COMPLETED")).toEqual(true)
      })

      it("12. una falla intermedia revierte los niveles ya escritos (compensación real, no estado corrupto)", async () => {
        const { supplier, warehouseMY, variantId, mapping } = await setupMappingWithWarehouses()
        const syncRun1 = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "APPLY",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun1.id,
              normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 5 }],
            },
          },
        })

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const updateSpy = jest
          .spyOn(supplierService, "updateSupplierProductStates")
          .mockRejectedValue(new Error("boom"))

        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T11:00:00Z"))
        // No se afirma `.rejects.toThrow()` -- ver nota en el test de Link
        // más arriba: lo que importa es el efecto real de la compensación.
        try {
          await applyReconciledInventoryWorkflow(container())
            .run({
              input: {
                result: {
                  action: "APPLY",
                  supplierProductMappingId: mapping.id,
                  syncRunId: syncRun2.id,
                  normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseMY.id, quantity: 999 }],
                },
              },
            })
            .catch(() => {})
        } finally {
          updateSpy.mockRestore()
        }

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLink] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const level = await getInventoryLevel(variantId, (whLink as any).stock_location_id)
        // El workflow falló DESPUÉS de escribir el nivel -> la compensación
        // nativa de batchInventoryItemLevelsWorkflow debe haberlo revertido
        // a 5, nunca dejarlo corrupto en 999.
        expect(Number(level.stocked_quantity)).toEqual(5)
      })
    })

    describe("Etapa 4, §22 — escenario integrado real: Etapa 2 -> 3 -> 4", () => {
      it("Order feliz: fixture Exel normalizado -> Reconciliation APPLY -> Inventory refleja MY=4/MX=6", async () => {
        const supplier = await createSupplier("e2e_happy")
        const warehouseMY = await createWarehouse(supplier.id, "MY", "Monterrey")
        const warehouseMX = await createWarehouse(supplier.id, "MX", "México")
        const variantId = await createVariant("Variant E2E LAPTOP-001", "ABC123")
        const mapping = await createMappingViaWorkflow(supplier.id, variantId, "ABC123")
        const syncRun = await createSyncRun(supplier.id, new Date("2026-10-02T10:00:00Z"))

        // Reconciliation (Etapa 3, función real, no simulada): catalog
        // total=10, MY=4, MX=6 -> consistente.
        const classification = classifyConflicts(
          {
            supplierSku: "ABC123",
            catalogTotal: 10,
            warehouseReadings: [
              { warehouseExternalCode: "MY", quantity: 4 },
              { warehouseExternalCode: "MX", quantity: 6 },
            ],
            knownWarehouseCodes: ["MY", "MX"],
          },
          { matchingMappingIds: [mapping.id], isDuplicateReferenceInSnapshot: false, upstreamError: false }
        )
        expect(classification.action).toEqual("APPLY")
        if (classification.action !== "APPLY") return

        const reconciliationResult: ReconciliationResult = {
          action: "APPLY",
          supplierProductMappingId: mapping.id,
          syncRunId: syncRun.id,
          normalizedWarehouseLevels: [
            { supplierWarehouseId: warehouseMY.id, quantity: classification.warehouseTotals.MY },
            { supplierWarehouseId: warehouseMX.id, quantity: classification.warehouseTotals.MX },
          ],
        }

        const { result: applyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: { result: reconciliationResult },
        })
        expect(applyResult.proceed).toEqual(true)

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const [whLinkMY] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMY.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const [whLinkMX] = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouseMX.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const levelMY = await getInventoryLevel(variantId, (whLinkMY as any).stock_location_id)
        const levelMX = await getInventoryLevel(variantId, (whLinkMX as any).stock_location_id)
        expect(Number(levelMY.stocked_quantity) + Number(levelMX.stocked_quantity)).toEqual(10)

        // Ahora llega un snapshot conflictivo (catalog=90, MY=2, MX=0) ->
        // QUARANTINE, y el inventario NUNCA debe sobreescribirse.
        const syncRun2 = await createSyncRun(supplier.id, new Date("2026-10-02T11:00:00Z"))
        const conflictingClassification = classifyConflicts(
          {
            supplierSku: "ABC123",
            catalogTotal: 90,
            warehouseReadings: [
              { warehouseExternalCode: "MY", quantity: 2 },
              { warehouseExternalCode: "MX", quantity: 0 },
            ],
            knownWarehouseCodes: ["MY", "MX"],
          },
          { matchingMappingIds: [mapping.id], isDuplicateReferenceInSnapshot: false, upstreamError: false }
        )
        expect(conflictingClassification.action).toEqual("QUARANTINE")
        if (conflictingClassification.action !== "QUARANTINE") return

        const { result: secondApplyResult } = await applyReconciledInventoryWorkflow(container()).run({
          input: {
            result: {
              action: "QUARANTINE",
              supplierProductMappingId: mapping.id,
              syncRunId: syncRun2.id,
              conflictType: conflictingClassification.conflictType,
            },
          },
        })
        expect(secondApplyResult.proceed).toEqual(false)

        const levelMYAfter = await getInventoryLevel(variantId, (whLinkMY as any).stock_location_id)
        const levelMXAfter = await getInventoryLevel(variantId, (whLinkMX as any).stock_location_id)
        expect(Number(levelMYAfter.stocked_quantity)).toEqual(4)
        expect(Number(levelMXAfter.stocked_quantity)).toEqual(6)

        // Verificación extra del contador real de Etapa 3 sobre este mismo
        // conflicto (nextQuarantineState) — demuestra que ambas etapas
        // (reconciliación y la decisión de inventario) están de acuerdo.
        const nextState = nextQuarantineState(
          { status: "active", consecutiveConsistentRuns: 2 },
          conflictingClassification
        )
        expect(nextState).toEqual({ status: "quarantined", consecutiveConsistentRuns: 0 })
      })
    })
  },
})
