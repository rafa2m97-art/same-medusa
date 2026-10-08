import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { asValue } from "@medusajs/framework/awilix"
import { SUPPLIER_MODULE } from "../../src/modules/supplier"
import type SupplierModuleService from "../../src/modules/supplier/service"
import { createSupplierProductMappingWorkflow } from "../../src/modules/supplier/workflows/create-supplier-product-mapping"
import { applyReconciledInventoryWorkflow } from "../../src/modules/supplier/workflows/apply-reconciled-inventory"
import type { ReconciliationResult } from "../../src/modules/supplier/reconciliation/reconciliation-result"
import { WAREHOUSE_ROUTING_MODULE } from "../../src/modules/warehouse-routing"
import type WarehouseRoutingModuleService from "../../src/modules/warehouse-routing/service"
import { runCartAllocationWorkflow } from "../../src/modules/warehouse-routing/workflows/run-cart-allocation"
import { CHECKOUT_GUARDS_MODULE } from "../../src/modules/checkout-guards"
import type CheckoutGuardsModuleService from "../../src/modules/checkout-guards/service"
import { PACKAGE_PLANNING_MODULE } from "../../src/modules/package-planning"
import type PackagePlanningModuleService from "../../src/modules/package-planning/service"
import { planAndQuoteShippingWorkflow } from "../../src/modules/package-planning/workflows/plan-and-quote-shipping"
import { seedCarrierLimits } from "../../src/modules/package-planning/seed-carrier-limits"
import { SHIPPING_RATE_PROVIDER } from "../../src/modules/package-planning/shipping-rate-provider-registry"
import { FakeShippingRateProvider, fakeRate } from "../../src/modules/package-planning/__fixtures__/fake-shipping-rate-provider"
import {
  COMMERCE_AUDIT_EMITTER,
  InMemoryCommerceAuditEmitter,
} from "../../src/modules/commerce-audit/events"

jest.setTimeout(300000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const container = () => getContainer()

    async function createVariant(
      title: string,
      opts: { weightKg?: number | null; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null } = {}
    ) {
      const productService = container().resolve(Modules.PRODUCT)
      const [product] = await productService.createProducts([{ title: `Product ${title}`, status: "draft" }])
      const [variant] = await productService.createProductVariants([
        {
          title,
          sku: title,
          product_id: product.id,
          weight: "weightKg" in opts ? opts.weightKg : 2,
          length: "lengthCm" in opts ? opts.lengthCm : 20,
          width: "widthCm" in opts ? opts.widthCm : 15,
          height: "heightCm" in opts ? opts.heightCm : 10,
        },
      ])
      return variant.id as string
    }

    async function createSupplier(code: string) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSuppliers({ code, name: code, adapter_key: code, is_primary_pricing_source: true })
    }

    async function createWarehouse(supplierId: string, externalCode: string, overrides: Record<string, unknown> = {}) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSupplierWarehouses({
        supplier_id: supplierId,
        external_code: externalCode,
        name: externalCode,
        address: "Av. Industrias 100",
        district: "Centro",
        city: "San Nicolás de los Garza",
        state: "NLE",
        country: "MX",
        postal_code: "66422",
        phone: "8117986338",
        ...overrides,
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
      return supplierService.createSyncRuns({ supplier_id: supplierId, mode: "dry_run", status: "running", started_at: new Date() })
    }

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

    async function createCart() {
      const cartService = container().resolve(Modules.CART)
      return cartService.createCarts({ currency_code: "mxn" })
    }

    async function addLineItem(cartId: string, variantId: string, quantity: number, title: string) {
      const cartService = container().resolve(Modules.CART)
      const [item] = await cartService.addLineItems(cartId, [{ title, variant_id: variantId, quantity, unit_price: 100 }])
      return item
    }

    async function setShippingAddress(cartId: string) {
      const cartService = container().resolve(Modules.CART)
      await cartService.updateCarts(cartId, {
        shipping_address: {
          first_name: "Cliente",
          last_name: "Test",
          address_1: "Av. Siempre Viva 123",
          address_2: "456",
          city: "Monterrey",
          province: "NLE",
          postal_code: "64000",
          country_code: "mx",
          phone: "8112345678",
        },
      })
    }

    async function allocate(cartId: string, lines: Array<{ variantId: string; quantity: number }>) {
      const { result } = await runCartAllocationWorkflow(container()).run({
        input: {
          cartId,
          lines,
          destination: { state: "NLE", latitude: null, longitude: null },
          singleOriginEnabled: false,
          preferredWarehouseCode: null,
        },
      })
      return result
    }

    function registerProvider(provider: FakeShippingRateProvider) {
      container().register(SHIPPING_RATE_PROVIDER, asValue(provider))
    }

    async function planAndQuote(cartId: string) {
      const { result } = await planAndQuoteShippingWorkflow(container()).run({ input: { cartId } })
      return result
    }

    beforeAll(async () => {
      await seedCarrierLimits(container())
    })

    beforeEach(() => {
      container().register(COMMERCE_AUDIT_EMITTER, asValue(new InMemoryCommerceAuditEmitter()))
    })

    describe("Etapa 8 — camino feliz, un solo origen", () => {
      it("produce 3 ShippingSelection (cheapest/fastest/recommended) con 1 ShippingQuote cada una", async () => {
        const supplier = await createSupplier("exel_happy1")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant Happy1")
        const mapping = await createMapping(supplier.id, variantId, "SKU-HAPPY1")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)

        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant Happy1")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])

        registerProvider(
          new FakeShippingRateProvider("fake-envia", {
            mode: "success",
            rates: [fakeRate({ carrierCode: "fedex", amount: 150, estimatedDeliveryDays: 3 }), fakeRate({ carrierCode: "dhl", amount: 120, estimatedDeliveryDays: 5 })],
          })
        )

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("QUOTED")
        expect(result.shippingSelectionIds).toHaveLength(3)

        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const selections = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id })
        expect(selections).toHaveLength(3)
        const selected = selections.find((s) => s.status === "selected")
        expect(selected?.service_level).toBe("recommended")

        const cheapestSelection = selections.find((s) => s.service_level === "cheapest")!
        expect(Number(cheapestSelection.total_customer_amount)).toBe(120)
        const fastestSelection = selections.find((s) => s.service_level === "fastest")!
        expect(Number(fastestSelection.total_customer_amount)).toBe(150)
      })

      it("cada ShippingQuote conserva carrier/service normalizados y la referencia del provider (plan §21)", async () => {
        const supplier = await createSupplier("exel_carrierfreeze")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant CarrierFreeze")
        const mapping = await createMapping(supplier.id, variantId, "SKU-CARRIERFREEZE")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant CarrierFreeze")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerProvider(
          new FakeShippingRateProvider("fake-envia", {
            mode: "success",
            rates: [fakeRate({ carrierCode: "dhl", serviceCode: "DHL_GROUND", amount: 99, providerQuoteReference: "q-ref-123" })],
          })
        )

        await planAndQuote(cart.id)
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [quote] = await checkoutGuardsService.listShippingQuotes({ cart_id: cart.id })
        expect(quote.carrier_code).toBe("dhl")
        expect(quote.service_code).toBe("DHL_GROUND")
        expect(quote.quote_reference).toBe("q-ref-123")
      })
    })

    describe("Etapa 8 — multi-origen", () => {
      it("cotiza cada origen por separado y suma el total correctamente (plan §19)", async () => {
        const supplierA = await createSupplier("exel_multi_a8")
        const supplierB = await createSupplier("syscom_multi_b8")
        const warehouseA = await createWarehouse(supplierA.id, "MY")
        const warehouseB = await createWarehouse(supplierB.id, "MTY", { postal_code: "64000" })
        const variantA = await createVariant("Multi8 A")
        const variantB = await createVariant("Multi8 B")
        const mappingA = await createMapping(supplierA.id, variantA, "SKU-MULTI8-A")
        const mappingB = await createMapping(supplierB.id, variantB, "SKU-MULTI8-B")
        await stockUp(mappingA.id, supplierA.id, warehouseA.id, 10)
        await stockUp(mappingB.id, supplierB.id, warehouseB.id, 10)

        const cart = await createCart()
        await addLineItem(cart.id, variantA, 1, "Multi8 A")
        await addLineItem(cart.id, variantB, 1, "Multi8 B")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [
          { variantId: variantA, quantity: 1 },
          { variantId: variantB, quantity: 1 },
        ])

        registerProvider(
          new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate({ amount: 100 })] })
        )

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("QUOTED")

        const packagePlanningService = container().resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
        const plans = await packagePlanningService.listPackagePlans({ status: "active" })
        const warehouseIds = plans.map((p) => p.supplier_warehouse_id).sort()
        expect(warehouseIds.sort()).toEqual([warehouseA.id, warehouseB.id].sort())

        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const selections = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id, service_level: "cheapest" })
        expect(Number(selections[0].total_customer_amount)).toBe(200) // 100 + 100, un paquete por origen
      })

      it("nunca mezcla items de dos orígenes distintos en un mismo PackagePlan (plan §6)", async () => {
        const supplierA = await createSupplier("exel_nomix")
        const supplierB = await createSupplier("syscom_nomix")
        const warehouseA = await createWarehouse(supplierA.id, "MY")
        const warehouseB = await createWarehouse(supplierB.id, "MTY", { postal_code: "64000" })
        const variantA = await createVariant("NoMix A")
        const variantB = await createVariant("NoMix B")
        const mappingA = await createMapping(supplierA.id, variantA, "SKU-NOMIX-A")
        const mappingB = await createMapping(supplierB.id, variantB, "SKU-NOMIX-B")
        await stockUp(mappingA.id, supplierA.id, warehouseA.id, 10)
        await stockUp(mappingB.id, supplierB.id, warehouseB.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantA, 1, "NoMix A")
        await addLineItem(cart.id, variantB, 1, "NoMix B")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [
          { variantId: variantA, quantity: 1 },
          { variantId: variantB, quantity: 1 },
        ])
        registerProvider(new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate()] }))
        await planAndQuote(cart.id)

        const packagePlanningService = container().resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
        const plans = await packagePlanningService.listPackagePlans({ status: "active" })
        for (const plan of plans) {
          const packages = await packagePlanningService.listPackages({ package_plan_id: plan.id })
          for (const pkg of packages) {
            const items = await packagePlanningService.listPackageItems({ package_id: pkg.id })
            const variantsInPackage = new Set(items.map((i) => i.variant_id))
            // Cada PackagePlan pertenece a UN origen -- sus items nunca incluyen la variant del OTRO origen.
            expect(variantsInPackage.has(plan.supplier_id === supplierA.id ? variantB : variantA)).toBe(false)
          }
        }
      })
    })

    describe("Etapa 8 — datos físicos faltantes y paquetes irrealizables", () => {
      it("retorna INCOMPLETE/MISSING_PHYSICAL_DATA sin llamar a Envia cuando falta peso/dimensiones", async () => {
        const supplier = await createSupplier("exel_missingdata")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant MissingData", { weightKg: null })
        const mapping = await createMapping(supplier.id, variantId, "SKU-MISSINGDATA")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant MissingData")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])

        const provider = new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate()] })
        registerProvider(provider)

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("INCOMPLETE")
        expect(result.failures?.[0].reason).toBe("MISSING_PHYSICAL_DATA")
        expect(provider.callCount).toBe(0)
      })

      it("retorna INCOMPLETE/UNSHIPPABLE cuando un item excede los límites por sí solo", async () => {
        const supplier = await createSupplier("exel_unshippable8")
        const warehouse = await createWarehouse(supplier.id, "MY")
        // 500kg/200cm quedan DENTRO de los umbrales de auto-detección g/mm
        // (<=1000kg, <=300cm) -- no se "normalizan" a un valor pequeño, y
        // siguen excediendo por mucho los límites "default" (30kg/80-120cm).
        const variantId = await createVariant("Variant Unshippable8", { weightKg: 500, lengthCm: 200, widthCm: 200, heightCm: 200 })
        const mapping = await createMapping(supplier.id, variantId, "SKU-UNSHIPPABLE8")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant Unshippable8")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerProvider(new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate()] }))

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("INCOMPLETE")
        expect(result.failures?.[0].reason).toBe("UNSHIPPABLE")

        const packagePlanningService = container().resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
        const [plan] = await packagePlanningService.listPackagePlans({ supplier_warehouse_id: warehouse.id })
        expect(plan.status).toBe("unshippable")
      })

      it("falla explícitamente (nunca inventa un origen) cuando el SupplierWarehouse no tiene código postal", async () => {
        const supplier = await createSupplier("exel_noaddress")
        const warehouse = await createWarehouse(supplier.id, "MY", { postal_code: null })
        const variantId = await createVariant("Variant NoAddress")
        const mapping = await createMapping(supplier.id, variantId, "SKU-NOADDRESS")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant NoAddress")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerProvider(new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate()] }))

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("INCOMPLETE")
        expect(result.failures?.[0].reason).toBe("PROVIDER_ERROR")
        expect(result.failures?.[0].details.reason).toBe("incomplete_warehouse_address")
      })
    })

    describe("Etapa 8 — errores de proveedor y circuit breaker", () => {
      it("retorna INCOMPLETE/PROVIDER_ERROR cuando Envia rechaza la dirección, y nunca inventa $0 (plan §29/§30)", async () => {
        const supplier = await createSupplier("exel_invalidaddr")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant InvalidAddr")
        const mapping = await createMapping(supplier.id, variantId, "SKU-INVALIDADDR")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant InvalidAddr")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerProvider(new FakeShippingRateProvider("fake-envia", { mode: "error", errorCode: "INVALID_ADDRESS" }))

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("INCOMPLETE")
        expect(result.failures?.[0].reason).toBe("PROVIDER_ERROR")
        expect((result.failures?.[0].details as any).errorCode).toBe("INVALID_ADDRESS")
      })

      it("abre el circuito tras una falla de proveedor y no vuelve a llamarlo hasta que cierre (plan §41)", async () => {
        const supplier = await createSupplier("exel_circuit8")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant Circuit8")
        const mapping = await createMapping(supplier.id, variantId, "SKU-CIRCUIT8")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant Circuit8")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])

        const provider = new FakeShippingRateProvider("fake-envia", { mode: "error", errorCode: "PROVIDER_UNAVAILABLE" })
        registerProvider(provider)
        await planAndQuote(cart.id)
        expect(provider.callCount).toBeGreaterThan(0)

        const callsBefore = provider.callCount
        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("INCOMPLETE")
        expect(result.failures?.[0].details.reason).toBe("circuit_open")
        expect(provider.callCount).toBe(callsBefore)
      })
    })

    describe("Etapa 8 — idempotencia y fingerprint", () => {
      it("reutiliza el mismo PackagePlan cuando se vuelve a correr sin cambios (sin duplicar filas)", async () => {
        const supplier = await createSupplier("exel_idempotent8")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant Idempotent8")
        const mapping = await createMapping(supplier.id, variantId, "SKU-IDEMPOTENT8")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant Idempotent8")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerProvider(new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate()] }))

        await planAndQuote(cart.id)
        const packagePlanningService = container().resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
        const plansAfterFirst = await packagePlanningService.listPackagePlans({ supplier_warehouse_id: warehouse.id })

        await planAndQuote(cart.id)
        const plansAfterSecond = await packagePlanningService.listPackagePlans({ supplier_warehouse_id: warehouse.id })
        expect(plansAfterSecond).toHaveLength(plansAfterFirst.length)
      })
    })

    describe("Etapa 8 — escenario integrado Etapas 2 -> 8", () => {
      it("Order feliz completo hasta ShippingSelection seleccionada, lista para Checkout Guards (Etapa 7)", async () => {
        const supplier = await createSupplier("exel_integrated28")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant Integrated28")
        const mapping = await createMapping(supplier.id, variantId, "SKU-INTEGRATED28")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, "Variant Integrated28")
        await setShippingAddress(cart.id)
        const allocation = await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerProvider(new FakeShippingRateProvider("fake-envia", { mode: "success", rates: [fakeRate({ amount: 140 })] }))

        const result = await planAndQuote(cart.id)
        expect(result.status).toBe("QUOTED")

        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [selected] = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id, status: "selected" })
        expect(selected).toBeDefined()
        expect(selected.allocation_snapshot_id).toBe(allocation.snapshotId)
      })
    })

    describe("Etapa 8 — guardas de alcance (qué NO se hace todavía)", () => {
      it("EnviaAdapter nunca expone un método de compra de guía (plan §36)", () => {
        const source = require("../../src/integrations/fulfillment/envia/envia-adapter").EnviaAdapter.toString()
        expect(source).not.toMatch(/purchaseLabel|buyLabel|createLabel/i)
      })

      it("el contrato ShippingRateProvider no declara ninguna capacidad de compra de guía", () => {
        const typesSource = require("fs").readFileSync(
          require("path").join(__dirname, "../../src/modules/package-planning/types.ts"),
          "utf-8"
        )
        expect(typesSource).not.toMatch(/purchaseLabel|buyLabel/i)
      })
    })
  },
})
