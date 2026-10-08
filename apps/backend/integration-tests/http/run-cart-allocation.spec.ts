import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { asValue } from "@medusajs/framework/awilix"
import { SUPPLIER_MODULE } from "../../src/modules/supplier"
import type SupplierModuleService from "../../src/modules/supplier/service"
import { createSupplierProductMappingWorkflow } from "../../src/modules/supplier/workflows/create-supplier-product-mapping"
import { applyReconciledInventoryWorkflow } from "../../src/modules/supplier/workflows/apply-reconciled-inventory"
import type { ReconciliationResult } from "../../src/modules/supplier/reconciliation/reconciliation-result"
import { PRICING_RULES_MODULE } from "../../src/modules/pricing-rules"
import type PricingRulesModuleService from "../../src/modules/pricing-rules/service"
import { applySupplierPricingWorkflow } from "../../src/modules/pricing-rules/workflows/apply-supplier-pricing"
import { createPricingPolicyVersionWorkflow } from "../../src/modules/pricing-rules/workflows/create-pricing-policy-version"
import { WAREHOUSE_ROUTING_MODULE } from "../../src/modules/warehouse-routing"
import type WarehouseRoutingModuleService from "../../src/modules/warehouse-routing/service"
import { runCartAllocationWorkflow } from "../../src/modules/warehouse-routing/workflows/run-cart-allocation"
import expireAllocationSnapshotsJob from "../../src/jobs/expire-allocation-snapshots"
import {
  COMMERCE_AUDIT_EMITTER,
  InMemoryCommerceAuditEmitter,
} from "../../src/modules/commerce-audit/events"

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

    async function createSupplier(code: string, opts: { isPrimary?: boolean } = {}) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSuppliers({
        code,
        name: code,
        adapter_key: code,
        is_primary_pricing_source: opts.isPrimary ?? false,
      })
    }

    async function createWarehouse(
      supplierId: string,
      externalCode: string,
      coords?: { latitude: number; longitude: number }
    ) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSupplierWarehouses({
        supplier_id: supplierId,
        external_code: externalCode,
        name: externalCode,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      })
    }

    async function createMapping(supplierId: string, variantId: string, sku: string) {
      const { result } = await createSupplierProductMappingWorkflow(container()).run({
        input: { supplier_id: supplierId, variant_id: variantId, supplier_sku: sku },
      })
      return result
    }

    async function createSyncRun(supplierId: string) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSyncRuns({
        supplier_id: supplierId,
        mode: "dry_run",
        status: "running",
        started_at: new Date(),
      })
    }

    /** Stock real vía el camino de producción (Etapa 3->4): deja InventoryLevel Y SupplierProductState.last_apply_at ya puestos, exactamente como lo haría un sync real. */
    async function stockUp(mappingId: string, supplierId: string, warehouseId: string, quantity: number) {
      const syncRun = await createSyncRun(supplierId)
      const result: ReconciliationResult = {
        action: "APPLY",
        supplierProductMappingId: mappingId,
        syncRunId: syncRun.id,
        normalizedWarehouseLevels: [{ supplierWarehouseId: warehouseId, quantity }],
      }
      await applyReconciledInventoryWorkflow(container()).run({ input: { result } })
    }

    async function createRoutingRule(
      destinationState: string,
      supplierId: string,
      supplierWarehouseId: string,
      priority: number
    ) {
      const routingService = container().resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
      return routingService.createRoutingRules({
        destination_state: destinationState,
        supplier_id: supplierId,
        supplier_warehouse_id: supplierWarehouseId,
        priority,
      })
    }

    async function runAllocation(
      cartId: string,
      lines: Array<{ variantId: string; quantity: number }>,
      destination: { state: string | null; latitude?: number | null; longitude?: number | null },
      opts: { singleOriginEnabled?: boolean; preferredWarehouseCode?: string | null } = {}
    ) {
      const { result } = await runCartAllocationWorkflow(container()).run({
        input: {
          cartId,
          lines,
          destination: {
            state: destination.state,
            latitude: destination.latitude ?? null,
            longitude: destination.longitude ?? null,
          },
          singleOriginEnabled: opts.singleOriginEnabled ?? true,
          preferredWarehouseCode: opts.preferredWarehouseCode ?? null,
        },
      })
      return result
    }

    async function getSnapshot(snapshotId: string) {
      const routingService = container().resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
      return routingService.retrieveAllocationSnapshot(snapshotId)
    }

    async function listActiveSnapshots(cartId: string) {
      const routingService = container().resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
      return routingService.listAllocationSnapshots({ cart_id: cartId, status: "active" })
    }

    beforeEach(() => {
      container().register(COMMERCE_AUDIT_EMITTER, asValue(new InMemoryCommerceAuditEmitter()))
    })

    describe("Etapa 6 — consolidación single-origin real", () => {
      it("persiste un AllocationSnapshot ACTIVE con una sola asignación por línea, todas del mismo origen", async () => {
        const exel = await createSupplier("exel_single_origin")
        const my = await createWarehouse(exel.id, "MY")
        const variantA = await createVariant("Routing Single A")
        const variantB = await createVariant("Routing Single B")
        const mappingA = await createMapping(exel.id, variantA, "SKU-RS-A")
        const mappingB = await createMapping(exel.id, variantB, "SKU-RS-B")
        await stockUp(mappingA.id, exel.id, my.id, 10)
        await stockUp(mappingB.id, exel.id, my.id, 10)

        const result = await runAllocation(
          "cart_single_origin_1",
          [
            { variantId: variantA, quantity: 2 },
            { variantId: variantB, quantity: 3 },
          ],
          { state: "NL" }
        )

        expect(result.status).toBe("FULFILLABLE")
        expect(result.strategy).toBe("single_origin")
        expect(result.snapshotId).toBeTruthy()

        const snapshot = await getSnapshot(result.snapshotId!)
        expect(snapshot.status).toBe("active")
        expect(snapshot.strategy).toBe("single_origin")

        for (const line of result.lines!) {
          expect(line.assignments).toHaveLength(1)
          expect(line.assignments[0].supplierWarehouseId).toBe(my.id)
        }
      })
    })

    describe("Etapa 6 — split multi-origen real", () => {
      it("persiste 2+ AllocationAssignment para una línea que ningún almacén solo puede cubrir", async () => {
        const exel = await createSupplier("exel_split")
        const gd = await createWarehouse(exel.id, "GD")
        const mx = await createWarehouse(exel.id, "MX")
        const variant = await createVariant("Routing Split")
        const mapping = await createMapping(exel.id, variant, "SKU-RSPLIT")
        await stockUp(mapping.id, exel.id, gd.id, 3)
        await stockUp(mapping.id, exel.id, mx.id, 4)

        const result = await runAllocation(
          "cart_split_1",
          [{ variantId: variant, quantity: 6 }],
          { state: null },
          { singleOriginEnabled: false }
        )

        expect(result.status).toBe("FULFILLABLE")
        expect(result.strategy).toBe("multi_origin")
        expect(result.lines![0].assignments).toHaveLength(2)
        expect(
          result.lines![0].assignments.reduce((sum, a) => sum + a.quantity, 0)
        ).toBe(6)
      })
    })

    describe("Etapa 6 — all-or-nothing real", () => {
      it("no persiste ningún AllocationSnapshot cuando el carrito es irrealizable, y reporta shortages", async () => {
        const exel = await createSupplier("exel_unfulfillable")
        const my = await createWarehouse(exel.id, "MY")
        const variant = await createVariant("Routing Unfulfillable")
        const mapping = await createMapping(exel.id, variant, "SKU-RUNF")
        await stockUp(mapping.id, exel.id, my.id, 2)

        const cartId = "cart_unfulfillable_1"
        const result = await runAllocation(cartId, [{ variantId: variant, quantity: 10 }], { state: null })

        expect(result.status).toBe("UNFULFILLABLE")
        expect(result.snapshotId).toBeNull()
        expect(result.shortages).toEqual([
          { variantId: variant, requestedQuantity: 10, maxFulfillableQuantity: 2 },
        ])
        expect(await listActiveSnapshots(cartId)).toHaveLength(0)
      })
    })

    describe("Etapa 6 — idempotencia y ciclo de vida", () => {
      it("llamar dos veces con el mismo carrito/destino reutiliza el mismo snapshot (sin duplicar filas)", async () => {
        const exel = await createSupplier("exel_idempotent")
        const my = await createWarehouse(exel.id, "MY")
        const variant = await createVariant("Routing Idempotent")
        const mapping = await createMapping(exel.id, variant, "SKU-RIDEMP")
        await stockUp(mapping.id, exel.id, my.id, 10)

        const cartId = "cart_idempotent_1"
        const lines = [{ variantId: variant, quantity: 2 }]
        const first = await runAllocation(cartId, lines, { state: null })
        const second = await runAllocation(cartId, lines, { state: null })

        expect(first.snapshotId).toBe(second.snapshotId)
        expect(await listActiveSnapshots(cartId)).toHaveLength(1)
      })

      it("un cambio real en el carrito marca la snapshot anterior SUPERSEDED y crea una nueva ACTIVE", async () => {
        const exel = await createSupplier("exel_supersede")
        const my = await createWarehouse(exel.id, "MY")
        const variant = await createVariant("Routing Supersede")
        const mapping = await createMapping(exel.id, variant, "SKU-RSUPER")
        await stockUp(mapping.id, exel.id, my.id, 10)

        const cartId = "cart_supersede_1"
        const first = await runAllocation(cartId, [{ variantId: variant, quantity: 2 }], { state: null })
        const second = await runAllocation(cartId, [{ variantId: variant, quantity: 3 }], { state: null })

        expect(second.snapshotId).not.toBe(first.snapshotId)
        const previous = await getSnapshot(first.snapshotId!)
        expect(previous.status).toBe("superseded")
        expect(await listActiveSnapshots(cartId)).toHaveLength(1)
      })
    })

    describe("Etapa 6 — RoutingRule configurada vs. fallback por distancia", () => {
      it("una RoutingRule configurada gana sobre un almacén geográficamente más cercano sin regla", async () => {
        const exel = await createSupplier("exel_rule_wins")
        // "cerca" del destino (NL ~ 25.67,-100.3) pero SIN regla configurada.
        const near = await createWarehouse(exel.id, "NEAR", { latitude: 25.6, longitude: -100.2 })
        // lejos, pero CON una RoutingRule explícita de prioridad 0 para NL.
        const far = await createWarehouse(exel.id, "FAR", { latitude: 19.4, longitude: -99.1 })
        await createRoutingRule("NL", exel.id, far.id, 0)

        const variant = await createVariant("Routing Rule Wins")
        const mapping = await createMapping(exel.id, variant, "SKU-RRULE")
        await stockUp(mapping.id, exel.id, near.id, 5)
        await stockUp(mapping.id, exel.id, far.id, 5)

        const result = await runAllocation(
          "cart_rule_wins_1",
          [{ variantId: variant, quantity: 1 }],
          { state: "NL", latitude: 25.67, longitude: -100.3 }
        )

        expect(result.lines![0].assignments[0].supplierWarehouseId).toBe(far.id)
      })

      it("cae a distancia Haversine cuando no existe ninguna RoutingRule para el destino", async () => {
        const exel = await createSupplier("exel_distance_fallback")
        const near = await createWarehouse(exel.id, "NEAR2", { latitude: 25.6, longitude: -100.2 })
        const far = await createWarehouse(exel.id, "FAR2", { latitude: 19.4, longitude: -99.1 })

        const variant = await createVariant("Routing Distance Fallback")
        const mapping = await createMapping(exel.id, variant, "SKU-RDIST")
        await stockUp(mapping.id, exel.id, near.id, 5)
        await stockUp(mapping.id, exel.id, far.id, 5)

        const result = await runAllocation(
          "cart_distance_fallback_1",
          [{ variantId: variant, quantity: 1 }],
          { state: "NL", latitude: 25.67, longitude: -100.3 }
        )

        expect(result.lines![0].assignments[0].supplierWarehouseId).toBe(near.id)
      })
    })

    describe("Etapa 6 — elegibilidad real de candidatos", () => {
      it("excluye como origen un almacén cuyo mapping está quarantined, aunque tenga stock", async () => {
        const exel = await createSupplier("exel_quarantine_excl")
        const quarantined = await createWarehouse(exel.id, "QRT")
        const healthy = await createWarehouse(exel.id, "HLT")
        const variant = await createVariant("Routing Quarantine Exclusion")
        const mapping = await createMapping(exel.id, variant, "SKU-RQRT")
        await stockUp(mapping.id, exel.id, quarantined.id, 10)
        await stockUp(mapping.id, exel.id, healthy.id, 10)

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const [state] = await supplierService.listSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
        })
        await supplierService.updateSupplierProductStates([{ id: state.id, status: "quarantined" }])

        const result = await runAllocation(
          "cart_quarantine_excl_1",
          [{ variantId: variant, quantity: 1 }],
          { state: null }
        )

        // Ambos almacenes pertenecen al MISMO mapping (quarantined) -- ningún candidato queda elegible.
        expect(result.status).toBe("UNFULFILLABLE")
      })

      it("excluye como origen un almacén de un proveedor inactivo, aunque tenga stock", async () => {
        const exel = await createSupplier("exel_inactive_excl")
        const warehouse = await createWarehouse(exel.id, "INACT")
        const variant = await createVariant("Routing Inactive Supplier Exclusion")
        const mapping = await createMapping(exel.id, variant, "SKU-RINACT")
        await stockUp(mapping.id, exel.id, warehouse.id, 10)

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        await supplierService.updateSuppliers([{ id: exel.id, status: "inactive" }])

        const result = await runAllocation(
          "cart_inactive_excl_1",
          [{ variantId: variant, quantity: 1 }],
          { state: null }
        )

        expect(result.status).toBe("UNFULFILLABLE")
      })
    })

    describe("Etapa 6 — Pricing Source Selection es independiente de Routing/Sourcing", () => {
      it("el proveedor marcado is_primary_pricing_source no gana el ruteo automáticamente: Routing elige por stock/cobertura real, Pricing sigue leyendo del primario", async () => {
        await createPricingPolicyVersionWorkflow(container()).run({
          input: {
            code: "pricing-vs-routing-v1",
            supplierId: null,
            currencyCode: "mxn",
            marginFactor: 0.95,
            taxFactor: 1.16,
            minChangeRatio: 0.5,
            maxChangeRatio: 2.0,
          },
        })

        const primary = await createSupplier("exel_pricing_primary", { isPrimary: true })
        const secondary = await createSupplier("syscom_pricing_secondary", { isPrimary: false })
        const primaryWarehouse = await createWarehouse(primary.id, "PRIMARY_WH")
        const secondaryWarehouse = await createWarehouse(secondary.id, "SECONDARY_WH")

        const variant = await createVariant("Routing vs Pricing Source")
        const mappingPrimary = await createMapping(primary.id, variant, "SKU-PRIM")
        const mappingSecondary = await createMapping(secondary.id, variant, "SKU-SEC")

        // El primario de PRICING tiene POCO stock; el secundario cubre el carrito completo.
        await stockUp(mappingPrimary.id, primary.id, primaryWarehouse.id, 1)
        await stockUp(mappingSecondary.id, secondary.id, secondaryWarehouse.id, 10)

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingPrimary.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const result = await runAllocation(
          "cart_pricing_vs_routing_1",
          [{ variantId: variant, quantity: 5 }],
          { state: null },
          { singleOriginEnabled: false }
        )

        // Routing eligió al SECUNDARIO (el único que cubre la cantidad completa) --
        // nunca consultó is_primary_pricing_source para decidir esto.
        expect(result.status).toBe("FULFILLABLE")
        expect(result.lines![0].assignments[0].supplierId).toBe(secondary.id)

        // Pricing, totalmente aparte, sigue gobernado por PRIMARY_SUPPLIER.
        const pricingRulesService = container().resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
        const [pricingState] = await pricingRulesService.listPricingStates({ variant_id: variant })
        expect(pricingState.source_supplier_id).toBe(primary.id)
      })
    })

    describe("Etapa 6 — escenario integrado Etapa 2 -> 6", () => {
      it("sync -> reconciliación -> inventario -> pricing -> routing, todo con datos reales encadenados", async () => {
        await createPricingPolicyVersionWorkflow(container()).run({
          input: {
            code: "integrated-e2-e6-v1",
            supplierId: null,
            currencyCode: "mxn",
            marginFactor: 0.95,
            taxFactor: 1.16,
            minChangeRatio: 0.5,
            maxChangeRatio: 2.0,
          },
        })

        const exel = await createSupplier("exel_integrated_e6", { isPrimary: true })
        const syscom = await createSupplier("syscom_integrated_e6")
        const exelWarehouse = await createWarehouse(exel.id, "MY", { latitude: 25.67, longitude: -100.3 })
        const syscomWarehouse = await createWarehouse(syscom.id, "MTY", { latitude: 25.6, longitude: -100.25 })
        await createRoutingRule("NL", exel.id, exelWarehouse.id, 0)

        const variant = await createVariant("Integrated E2-E6")
        const mappingExel = await createMapping(exel.id, variant, "SKU-INT-EXEL")
        const mappingSyscom = await createMapping(syscom.id, variant, "SKU-INT-SYSCOM")

        // Etapa 3/4: sync real -> reconciliación -> inventario.
        await stockUp(mappingExel.id, exel.id, exelWarehouse.id, 8)
        await stockUp(mappingSyscom.id, syscom.id, syscomWarehouse.id, 8)

        // Etapa 5/5.1: costo real -> precio público vía el primario (Exel).
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        // Etapa 6: ruteo real para un carrito con destino NL.
        const result = await runAllocation(
          "cart_integrated_e2_e6",
          [{ variantId: variant, quantity: 3 }],
          { state: "NL", latitude: 25.67, longitude: -100.3 }
        )

        expect(result.status).toBe("FULFILLABLE")
        expect(result.strategy).toBe("single_origin")
        expect(result.lines![0].assignments[0].supplierWarehouseId).toBe(exelWarehouse.id)

        const snapshot = await getSnapshot(result.snapshotId!)
        expect(snapshot.routing_policy_version).toBe("default-v1")

        const pricingRulesService = container().resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
        const [pricingState] = await pricingRulesService.listPricingStates({ variant_id: variant })
        expect(pricingState.last_classification).toBe("ACCEPT")
      })
    })

    describe("Etapa 6 — ciclo de vida TTL (expiración real)", () => {
      it("el job de expiración transiciona a 'expired' una snapshot ACTIVE cuyo expires_at ya pasó, y no toca una vigente", async () => {
        const exel = await createSupplier("exel_expiry")
        const warehouse = await createWarehouse(exel.id, "MY")
        const variant = await createVariant("Routing Expiry")
        const mapping = await createMapping(exel.id, variant, "SKU-REXP")
        await stockUp(mapping.id, exel.id, warehouse.id, 10)

        const expiredCart = "cart_expiry_expired"
        const freshCart = "cart_expiry_fresh"
        const expiredResult = await runAllocation(expiredCart, [{ variantId: variant, quantity: 1 }], {
          state: null,
        })
        const freshResult = await runAllocation(freshCart, [{ variantId: variant, quantity: 1 }], {
          state: null,
        })

        const routingService = container().resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
        await routingService.updateAllocationSnapshots([
          { id: expiredResult.snapshotId!, expires_at: new Date(Date.now() - 1000) },
        ])

        await expireAllocationSnapshotsJob(container())

        const expiredSnapshot = await getSnapshot(expiredResult.snapshotId!)
        const freshSnapshot = await getSnapshot(freshResult.snapshotId!)
        expect(expiredSnapshot.status).toBe("expired")
        expect(freshSnapshot.status).toBe("active")
      })
    })
  },
})
