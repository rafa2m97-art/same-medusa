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
import { CHECKOUT_GUARDS_MODULE } from "../../src/modules/checkout-guards"
import type CheckoutGuardsModuleService from "../../src/modules/checkout-guards/service"
import { PACKAGE_PLANNING_MODULE } from "../../src/modules/package-planning"
import type PackagePlanningModuleService from "../../src/modules/package-planning/service"
import { prepareCheckoutForPaymentWorkflow } from "../../src/modules/checkout-guards/workflows/prepare-checkout-for-payment"
import { SUPPLIER_ADAPTER_REGISTRY, MapSupplierAdapterRegistry } from "../../src/modules/checkout-guards/supplier-adapter-registry"
import { FakeSupplierAdapter } from "../../src/modules/checkout-guards/__fixtures__/fake-supplier-adapter"
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
      const [product] = await productService.createProducts([{ title: `Product ${title}`, status: "draft" }])
      const [variant] = await productService.createProductVariants([
        { title, sku: sku ?? title, product_id: product.id },
      ])
      return variant.id as string
    }

    async function createSupplier(code: string) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSuppliers({ code, name: code, adapter_key: code, is_primary_pricing_source: true })
    }

    async function createWarehouse(supplierId: string, externalCode: string) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSupplierWarehouses({ supplier_id: supplierId, external_code: externalCode, name: externalCode })
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

    async function createDefaultPolicy(code: string) {
      await createPricingPolicyVersionWorkflow(container()).run({
        input: {
          code,
          supplierId: null,
          currencyCode: "mxn",
          marginFactor: 0.95,
          taxFactor: 1.16,
          minChangeRatio: 0.5,
          maxChangeRatio: 2.0,
        },
      })
    }

    async function createCart(currencyCode = "mxn") {
      const cartService = container().resolve(Modules.CART)
      return cartService.createCarts({ currency_code: currencyCode })
    }

    async function addLineItem(cartId: string, variantId: string, quantity: number, unitPrice: number, title: string) {
      const cartService = container().resolve(Modules.CART)
      const [item] = await cartService.addLineItems(cartId, [
        { title, variant_id: variantId, quantity, unit_price: unitPrice },
      ])
      return item
    }

    async function setShippingAddress(cartId: string, overrides: Record<string, unknown> = {}) {
      const cartService = container().resolve(Modules.CART)
      // El FK `shipping_address_id` no se escribe directo -- el campo
      // real que el cart module acepta en updateCarts() es la relación
      // anidada `shipping_address` (confirmado leyendo
      // @medusajs/core-flows/dist/cart/workflows/update-cart.js), que
      // crea+liga la Address en una sola llamada.
      const updated = await cartService.updateCarts(cartId, {
        shipping_address: {
          address_1: "Av. Siempre Viva 123",
          city: "Monterrey",
          province: "NLE",
          postal_code: "64000",
          country_code: "mx",
          phone: "8112345678",
          ...overrides,
        },
      })
      return updated.shipping_address
    }

    async function allocate(
      cartId: string,
      lines: Array<{ variantId: string; quantity: number }>,
      opts: { destinationState?: string | null } = {}
    ) {
      const { result } = await runCartAllocationWorkflow(container()).run({
        input: {
          cartId,
          lines,
          // Default "NLE" -- coincide con `province` del address por defecto
          // de setShippingAddress(); un mismatch entre el destino usado para
          // calcular la AllocationSnapshot y la dirección real del carrito
          // es, correctamente, un CART_CHANGED real (Etapa 6/7) -- los
          // tests que no cambian la dirección deben pasar el MISMO destino.
          destination: { state: opts.destinationState ?? "NLE", latitude: null, longitude: null },
          singleOriginEnabled: true,
          preferredWarehouseCode: null,
        },
      })
      return result
    }

    /**
     * Etapa 8 extendió el guard de Etapa 7 para leer una
     * `ShippingSelection` seleccionada (una quote por origen) en vez de
     * una `ShippingQuote` suelta -- este fixture crea ambas, la
     * selección ya marcada "selected" (como si el cliente ya hubiera
     * elegido una opción), para que los tests de Etapa 7 (una sola
     * quote, un solo origen) sigan siendo válidos sin cambiar su intención.
     */
    async function createShippingQuote(
      cartId: string,
      allocationSnapshotId: string,
      overrides: Record<string, unknown> = {}
    ) {
      const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
      const amount = ("amount" in overrides ? overrides.amount : 150) as number
      const selection = await checkoutGuardsService.createShippingSelections({
        cart_id: cartId,
        allocation_snapshot_id: allocationSnapshotId,
        service_level: "recommended",
        total_customer_amount: amount,
        total_provider_amount: amount,
        currency_code: "mxn",
        status: "selected",
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
      })
      return checkoutGuardsService.createShippingQuotes({
        cart_id: cartId,
        allocation_snapshot_id: allocationSnapshotId,
        shipping_selection_id: selection.id,
        carrier_name: "fake-carrier",
        amount: 150,
        currency_code: "mxn",
        is_free_shipping: false,
        status: "active",
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
        ...overrides,
      })
    }

    function registerSupplierAdapters(adaptersByKey: Record<string, FakeSupplierAdapter>) {
      container().register(
        SUPPLIER_ADAPTER_REGISTRY,
        asValue(new MapSupplierAdapterRegistry(new Map(Object.entries(adaptersByKey))))
      )
    }

    async function prepare(cartId: string, overrides: Record<string, unknown> = {}) {
      const { result } = await prepareCheckoutForPaymentWorkflow(container()).run({
        input: { cartId, ...overrides },
      })
      return result
    }

    beforeAll(async () => {
      // Regla tax-inclusive de Etapa 5 (plan §44): sin esto,
      // calculatePrices() devuelve is_calculated_price_tax_inclusive
      // en false y el Price Guard correctamente lo trataría como
      // PRICE_INVALID -- se configura una sola vez para todo el
      // archivo, mismo patrón que el test de regresión de Etapa 5.
      const pricingService = container().resolve(Modules.PRICING)
      await pricingService.createPricePreferences({
        attribute: "currency_code",
        value: "mxn",
        is_tax_inclusive: true,
      })
    })

    beforeEach(() => {
      container().register(COMMERCE_AUDIT_EMITTER, asValue(new InMemoryCommerceAuditEmitter()))
    })

    /** Construye un carrito EXACTAMENTE listo para READY: 1 variant, 1 proveedor, stock, precio aceptado, allocation, dirección y shipping quote. */
    async function setupHappyPath(label: string) {
      const supplier = await createSupplier(`exel_${label}`)
      const warehouse = await createWarehouse(supplier.id, "MY")
      const variantId = await createVariant(`Variant ${label}`)
      const mapping = await createMapping(supplier.id, variantId, `SKU-${label}`)
      await stockUp(mapping.id, supplier.id, warehouse.id, 10)
      await createDefaultPolicy(`policy-${label}`)
      await applySupplierPricingWorkflow(container()).run({
        input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
      })

      const cart = await createCart()
      const lineItem = await addLineItem(cart.id, variantId, 1, 123, `Variant ${label}`)
      await setShippingAddress(cart.id)
      const allocation = await allocate(cart.id, [{ variantId, quantity: 1 }])
      await createShippingQuote(cart.id, allocation.snapshotId!)

      const fakeAdapter = new FakeSupplierAdapter(supplier.adapter_key)
      registerSupplierAdapters({ [supplier.adapter_key]: fakeAdapter })

      return { supplier, warehouse, variantId, mapping, cart, lineItem, allocation, fakeAdapter }
    }

    describe("Etapa 7 — camino feliz", () => {
      it("llega a READY_FOR_PAYMENT con el authorized_amount correcto (precio + envío)", async () => {
        const { cart } = await setupHappyPath("happy1")
        const result = await prepare(cart.id)
        expect(result.status).toBe("READY")
        expect(result.authorizedAmount).toBe(123 + 150)
        expect(result.currencyCode).toBe("mxn")
      })

      it("persiste un CheckoutReadiness con status ready y expires_at futuro", async () => {
        const { cart } = await setupHappyPath("happy2")
        const result = await prepare(cart.id)
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const readiness = await checkoutGuardsService.retrieveCheckoutReadiness(result.readinessId)
        expect(readiness.status).toBe("ready")
        expect(readiness.expires_at!.getTime()).toBeGreaterThan(Date.now())
      })
    })

    describe("Etapa 7 — validación de AllocationSnapshot", () => {
      it("falla con ALLOCATION_INVALID cuando no existe ninguna allocation activa para el carrito", async () => {
        const cart = await createCart()
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("ALLOCATION_INVALID")
        expect(result.requiresReallocation).toBe(true)
      })

      it("falla con CART_CHANGED cuando la cantidad del carrito cambió después de la allocation", async () => {
        const { cart, variantId } = await setupHappyPath("cartchanged")
        const cartService = container().resolve(Modules.CART)
        await cartService.updateLineItems({ cart_id: cart.id }, { quantity: 5 })
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("CART_CHANGED")
        expect(result.requiresReallocation).toBe(true)
      })

      it("falla con ALLOCATION_EXPIRED cuando la snapshot ya expiró", async () => {
        const { cart, allocation } = await setupHappyPath("expired")
        const routingService = container().resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
        await routingService.updateAllocationSnapshots([
          { id: allocation.snapshotId!, expires_at: new Date(Date.now() - 1000) },
        ])
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("ALLOCATION_EXPIRED")
      })
    })

    describe("Etapa 7 — Price Guard", () => {
      it("falla con PRICE_CHANGED cuando el precio del carrito ya no coincide con el autorizado por Pricing", async () => {
        const { cart, lineItem } = await setupHappyPath("pricechanged")
        const cartService = container().resolve(Modules.CART)
        await cartService.updateLineItems(lineItem.id, { unit_price: 999 })
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("PRICE_CHANGED")
        expect(result.customerActionRequired).toBe(true)
      })

      it("falla con PRICE_REQUIRES_REVIEW cuando PricingState.last_classification es REVIEW", async () => {
        const { cart, variantId } = await setupHappyPath("pricereview")
        const pricingRulesService = container().resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
        const [state] = await pricingRulesService.listPricingStates({ variant_id: variantId })
        await pricingRulesService.updatePricingStates([{ id: state.id, last_classification: "REVIEW" }])
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("PRICE_REQUIRES_REVIEW")
      })

      it("ignora un precio manipulado por el cliente en el carrito -- nunca cobra lo que el cliente mandó (plan §48)", async () => {
        const { cart, lineItem } = await setupHappyPath("pricemanipulated")
        const cartService = container().resolve(Modules.CART)
        await cartService.updateLineItems(lineItem.id, { unit_price: 1 })
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("PRICE_CHANGED")
        expect(result.authorizedAmount).toBeUndefined()
      })
    })

    describe("Etapa 7 — Reservation Guard", () => {
      it("crea una ReservationItem en el StockLocation exacto definido por la allocation", async () => {
        const { cart, mapping, warehouse } = await setupHappyPath("reservationexact")
        await prepare(cart.id)

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const whLinks = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouse.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const stockLocationId = (whLinks[0] as any).stock_location_id as string

        const inventoryService = container().resolve(Modules.INVENTORY)
        const reservations = await inventoryService.listReservationItems({ location_id: stockLocationId })
        expect(reservations.length).toBeGreaterThan(0)
      })

      it("es idempotente: preparar dos veces el mismo carrito deja reserved=1, nunca 2", async () => {
        const { cart, variantId } = await setupHappyPath("reservationidempotent")
        await prepare(cart.id)
        await prepare(cart.id)

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const itemLinks = await link.list(
          { [Modules.PRODUCT]: { variant_id: variantId }, [Modules.INVENTORY]: { inventory_item_id: { $ne: null } } },
          {}
        )
        const inventoryItemId = (itemLinks[0] as any).inventory_item_id as string
        const inventoryService = container().resolve(Modules.INVENTORY)
        const [level] = await inventoryService.listInventoryLevels({ inventory_item_id: inventoryItemId })
        expect(Number(level.reserved_quantity)).toBe(1)
      })

      it("falla con RESERVATION_FAILED y requiresReallocation cuando dos checkouts compiten por la última unidad (plan §34)", async () => {
        const supplier = await createSupplier("exel_lastunit")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant LastUnit")
        const mapping = await createMapping(supplier.id, variantId, "SKU-LASTUNIT")
        await stockUp(mapping.id, supplier.id, warehouse.id, 1)
        await createDefaultPolicy("policy-lastunit")
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const cartA = await createCart()
        await addLineItem(cartA.id, variantId, 1, 123, "Variant LastUnit")
        await setShippingAddress(cartA.id)
        const allocationA = await allocate(cartA.id, [{ variantId, quantity: 1 }])
        await createShippingQuote(cartA.id, allocationA.snapshotId!)

        const cartB = await createCart()
        await addLineItem(cartB.id, variantId, 1, 123, "Variant LastUnit")
        await setShippingAddress(cartB.id)
        const allocationB = await allocate(cartB.id, [{ variantId, quantity: 1 }])
        await createShippingQuote(cartB.id, allocationB.snapshotId!)

        const fakeAdapter = new FakeSupplierAdapter(supplier.adapter_key)
        registerSupplierAdapters({ [supplier.adapter_key]: fakeAdapter })

        const resultA = await prepare(cartA.id)
        const resultB = await prepare(cartB.id)

        const statuses = [resultA.status, resultB.status].sort()
        expect(statuses).toEqual(["NOT_READY", "READY"])
        const failed = resultA.status === "NOT_READY" ? resultA : resultB
        expect(failed.failureCode).toBe("RESERVATION_FAILED")
        expect(failed.requiresReallocation).toBe(true)
      })
    })

    describe("Etapa 7 — Live Supplier Confirmation", () => {
      it("falla con SUPPLIER_STOCK_REJECTED y libera la reserva cuando el proveedor rechaza", async () => {
        const { cart, fakeAdapter } = await setupHappyPath("rejected")
        fakeAdapter.setLiveConfirmationBehavior({ mode: "reject", reason: "sin stock real" })

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SUPPLIER_STOCK_REJECTED")
        expect(result.requiresReallocation).toBe(true)

        const inventoryService = container().resolve(Modules.INVENTORY)
        const reservations = await inventoryService.listReservationItems({})
        const active = reservations.filter((r: any) => !r.deleted_at)
        expect(active).toHaveLength(0)
      })

      it("falla con SUPPLIER_UNAVAILABLE en timeout y marca el circuito abierto para la siguiente llamada", async () => {
        const { cart, fakeAdapter, supplier } = await setupHappyPath("timeout")
        fakeAdapter.setLiveConfirmationBehavior({ mode: "timeout" })

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SUPPLIER_UNAVAILABLE")
        expect(result.retryable).toBe(true)

        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [circuit] = await checkoutGuardsService.listLiveConfirmationCircuitStates({
          integration_key: supplier.id,
        })
        expect(circuit).toBeDefined()
      })

      it("no llama al proveedor cuando el circuito ya está abierto (evita martillar la API)", async () => {
        const { cart, fakeAdapter, supplier } = await setupHappyPath("circuitopen")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        await checkoutGuardsService.createLiveConfirmationCircuitStates({
          integration_key: supplier.id,
          opened_at: new Date(),
        })
        const spy = jest.spyOn(fakeAdapter.inventory, "confirmAllocationLive")

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SUPPLIER_UNAVAILABLE")
        expect(spy).not.toHaveBeenCalled()
        spy.mockRestore()
      })

      it("rechazo de proveedor (REJECTED) nunca abre el circuito -- es una respuesta de negocio válida", async () => {
        const { cart, fakeAdapter, supplier } = await setupHappyPath("rejectednocircuit")
        fakeAdapter.setLiveConfirmationBehavior({ mode: "reject" })
        await prepare(cart.id)

        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const circuits = await checkoutGuardsService.listLiveConfirmationCircuitStates({ integration_key: supplier.id })
        expect(circuits).toHaveLength(0)
      })

      it("multi-proveedor: si TODOS confirman, continúa; si UNO rechaza, todo el checkout falla (plan §17)", async () => {
        const supplierA = await createSupplier("exel_multi_a")
        const supplierB = await createSupplier("syscom_multi_b")
        const warehouseA = await createWarehouse(supplierA.id, "MY")
        const warehouseB = await createWarehouse(supplierB.id, "MTY")
        const variantA = await createVariant("Multi A")
        const variantB = await createVariant("Multi B")
        const mappingA = await createMapping(supplierA.id, variantA, "SKU-MULTI-A")
        const mappingB = await createMapping(supplierB.id, variantB, "SKU-MULTI-B")
        await stockUp(mappingA.id, supplierA.id, warehouseA.id, 10)
        await stockUp(mappingB.id, supplierB.id, warehouseB.id, 10)
        await createDefaultPolicy("policy-multi")
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingA.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingB.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const cart = await createCart()
        await addLineItem(cart.id, variantA, 1, 123, "Multi A")
        await addLineItem(cart.id, variantB, 1, 123, "Multi B")
        await setShippingAddress(cart.id)
        const allocation = await allocate(cart.id, [
          { variantId: variantA, quantity: 1 },
          { variantId: variantB, quantity: 1 },
        ])
        await createShippingQuote(cart.id, allocation.snapshotId!)

        const fakeA = new FakeSupplierAdapter(supplierA.adapter_key)
        const fakeB = new FakeSupplierAdapter(supplierB.adapter_key)
        registerSupplierAdapters({ [supplierA.adapter_key]: fakeA, [supplierB.adapter_key]: fakeB })

        const okResult = await prepare(cart.id)
        expect(okResult.status).toBe("READY")

        fakeB.setLiveConfirmationBehavior({ mode: "reject" })
        const failResult = await prepare(cart.id)
        expect(failResult.status).toBe("NOT_READY")
        expect(failResult.failureCode).toBe("SUPPLIER_STOCK_REJECTED")
      })
    })

    describe("Etapa 7 — Address Guard", () => {
      it("falla con ADDRESS_INCOMPLETE cuando falta el código postal", async () => {
        const { cart } = await setupHappyPath("addressincomplete")
        const cartService = container().resolve(Modules.CART)
        const fullCart = await cartService.retrieveCart(cart.id, { relations: ["shipping_address"] })
        await cartService.updateAddresses({ id: (fullCart.shipping_address as any).id, postal_code: "" })

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("ADDRESS_INCOMPLETE")
        expect(result.customerActionRequired).toBe(true)
      })

      it("pasa sin teléfono cuando addressPhoneRequired se configura explícitamente en false", async () => {
        const { cart } = await setupHappyPath("addressphoneoptional")
        const cartService = container().resolve(Modules.CART)
        const fullCart = await cartService.retrieveCart(cart.id, { relations: ["shipping_address"] })
        await cartService.updateAddresses({ id: (fullCart.shipping_address as any).id, phone: "" })

        const result = await prepare(cart.id, { addressPhoneRequired: false })
        expect(result.status).toBe("READY")
      })
    })

    describe("Etapa 7 — Shipping Quote Guard", () => {
      it("falla con SHIPPING_QUOTE_MISSING cuando no existe ninguna quote", async () => {
        const supplier = await createSupplier("exel_noquote")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant NoQuote")
        const mapping = await createMapping(supplier.id, variantId, "SKU-NOQUOTE")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        await createDefaultPolicy("policy-noquote")
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, 123, "Variant NoQuote")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerSupplierAdapters({ [supplier.adapter_key]: new FakeSupplierAdapter(supplier.adapter_key) })

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SHIPPING_QUOTE_MISSING")
        expect(result.retryable).toBe(true)
      })

      it("falla con SHIPPING_QUOTE_MISSING (nunca $0 implícito) cuando amount es null sin is_free_shipping", async () => {
        const { cart, allocation } = await setupHappyPath("quotenullamount")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [quote] = await checkoutGuardsService.listShippingQuotes({ cart_id: cart.id })
        await checkoutGuardsService.updateShippingQuotes([{ id: quote.id, amount: null }])

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SHIPPING_QUOTE_MISSING")
      })

      it("pasa con amount=0 cuando is_free_shipping es explícito (free shipping real)", async () => {
        const supplier = await createSupplier("exel_freeship")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant FreeShip")
        const mapping = await createMapping(supplier.id, variantId, "SKU-FREESHIP")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        await createDefaultPolicy("policy-freeship")
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, 123, "Variant FreeShip")
        await setShippingAddress(cart.id)
        const allocation = await allocate(cart.id, [{ variantId, quantity: 1 }])
        await createShippingQuote(cart.id, allocation.snapshotId!, { amount: 0, is_free_shipping: true })
        registerSupplierAdapters({ [supplier.adapter_key]: new FakeSupplierAdapter(supplier.adapter_key) })

        const result = await prepare(cart.id)
        expect(result.status).toBe("READY")
        expect(result.authorizedAmount).toBe(123)
      })

      it("falla con SHIPPING_QUOTE_ALLOCATION_MISMATCH cuando la quote pertenece a una allocation distinta", async () => {
        const { cart, allocation } = await setupHappyPath("quotemismatch")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [quote] = await checkoutGuardsService.listShippingQuotes({ cart_id: cart.id })
        await checkoutGuardsService.updateShippingQuotes([
          { id: quote.id, allocation_snapshot_id: "as_other_mismatch" },
        ])
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SHIPPING_QUOTE_ALLOCATION_MISMATCH")
      })

      it("ignora un monto de envío manipulado por el cliente -- usa la quote autoritativa, nunca un valor de input (plan §48)", async () => {
        const { cart } = await setupHappyPath("shippingmanipulated")
        // El workflow no acepta ningún monto como input -- solo cartId y opciones de configuración.
        const result = await prepareCheckoutForPaymentWorkflow(container()).run({
          input: { cartId: cart.id, authorizedAmount: 1, shippingAmount: 1 } as any,
        })
        expect(result.result.authorizedAmount).toBe(123 + 150)
      })

      it("falla con SHIPPING_QUOTE_EXPIRED cuando la ShippingSelection ya expiró (re-validación post Etapa 8)", async () => {
        const { cart } = await setupHappyPath("selectionexpired")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [selection] = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id })
        await checkoutGuardsService.updateShippingSelections([
          { id: selection.id, expires_at: new Date(Date.now() - 1000) },
        ])
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SHIPPING_QUOTE_EXPIRED")
      })

      it("falla con SHIPPING_QUOTE_PACKAGE_PLAN_MISMATCH cuando la quote apunta a un PackagePlan ya superseded (Etapa 8, re-empacado)", async () => {
        const { cart, allocation } = await setupHappyPath("packageplanmismatch")
        const packagePlanningService = container().resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)

        const stalePlan = await packagePlanningService.createPackagePlans({
          allocation_snapshot_id: allocation.snapshotId!,
          supplier_id: "sup_irrelevant",
          supplier_warehouse_id: "wh_irrelevant",
          status: "superseded",
          fingerprint: "stale-fingerprint",
          packing_rule_version: "default-v1",
        })

        const [quote] = await checkoutGuardsService.listShippingQuotes({ cart_id: cart.id })
        await checkoutGuardsService.updateShippingQuotes([{ id: quote.id, package_plan_id: stalePlan.id }])

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SHIPPING_QUOTE_PACKAGE_PLAN_MISMATCH")
        expect(result.requiresReallocation).toBe(false)
        expect(result.retryable).toBe(true)
      })

      it("multi-origen: suma el customer amount de cada origen sin confundirlo con provider_amount (plan §7/§9 re-validación)", async () => {
        const { cart, allocation } = await setupHappyPath("multioriginsum")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [selection] = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id })
        const [existingQuote] = await checkoutGuardsService.listShippingQuotes({ cart_id: cart.id })

        // Un segundo origen hipotético con un provider_amount DISTINTO del
        // customer_amount -- el guard debe sumar `amount` (lo que paga el
        // cliente), nunca `provider_amount` (lo que Envia le cobra a SAME).
        await checkoutGuardsService.createShippingQuotes({
          cart_id: cart.id,
          allocation_snapshot_id: allocation.snapshotId!,
          shipping_selection_id: selection.id,
          carrier_name: "dhl",
          amount: 200,
          provider_amount: 260,
          currency_code: "mxn",
          is_free_shipping: false,
          status: "active",
          expires_at: new Date(Date.now() + 30 * 60 * 1000),
        })

        const result = await prepare(cart.id)
        expect(result.status).toBe("READY")
        // precio del item (123) + quote original (150) + segundo origen (200 customer, no 260 provider)
        expect(result.authorizedAmount).toBe(123 + Number(existingQuote.amount) + 200)
      })
    })

    describe("Etapa 7 — auditoría y fingerprint", () => {
      it("emite CHECKOUT_READY_FOR_PAYMENT solo en el camino feliz", async () => {
        const emitter = new InMemoryCommerceAuditEmitter()
        container().register(COMMERCE_AUDIT_EMITTER, asValue(emitter))
        const { cart } = await setupHappyPath("auditready")
        await prepare(cart.id)
        expect(emitter.events.map((e) => e.eventType)).toContain("CHECKOUT_READY_FOR_PAYMENT")
      })

      it("emite CHECKOUT_READINESS_INVALIDATED en cualquier NOT_READY", async () => {
        const emitter = new InMemoryCommerceAuditEmitter()
        container().register(COMMERCE_AUDIT_EMITTER, asValue(emitter))
        const cart = await createCart()
        await prepare(cart.id)
        expect(emitter.events.map((e) => e.eventType)).toContain("CHECKOUT_READINESS_INVALIDATED")
      })

      it("supersede un readiness READY anterior cuando se vuelve a preparar exitosamente", async () => {
        const { cart } = await setupHappyPath("supersede")
        const first = await prepare(cart.id)
        const second = await prepare(cart.id)
        expect(second.readinessId).not.toBe(first.readinessId)

        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const previous = await checkoutGuardsService.retrieveCheckoutReadiness(first.readinessId)
        expect(previous.status).toBe("superseded")
      })
    })

    describe("Etapa 7 — escenario integrado Etapas 2 -> 7", () => {
      it("Order feliz completo: sync -> reconciliación -> inventario -> pricing -> routing -> checkout guards -> READY_FOR_PAYMENT", async () => {
        const { cart, allocation } = await setupHappyPath("integrated27")
        const result = await prepare(cart.id)
        expect(result.status).toBe("READY")
        expect(allocation.strategy).toBe("single_origin")
        expect(result.authorizedAmount).toBe(273)
      })

      it("segundo escenario: otro proceso consume la última unidad después de Routing -> NOT_READY + requires_reallocation", async () => {
        const supplier = await createSupplier("exel_int_lastunit")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant IntLastUnit")
        const mapping = await createMapping(supplier.id, variantId, "SKU-INT-LASTUNIT")
        await stockUp(mapping.id, supplier.id, warehouse.id, 1)
        await createDefaultPolicy("policy-int-lastunit")
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, 123, "Variant IntLastUnit")
        await setShippingAddress(cart.id)
        const allocation = await allocate(cart.id, [{ variantId, quantity: 1 }])
        await createShippingQuote(cart.id, allocation.snapshotId!)
        registerSupplierAdapters({ [supplier.adapter_key]: new FakeSupplierAdapter(supplier.adapter_key) })

        // Otro proceso (ej. otro checkout, o un ajuste manual) consume la unidad vía una reserva directa.
        const link = container().resolve(ContainerRegistrationKeys.LINK)
        const itemLinks = await link.list(
          { [Modules.PRODUCT]: { variant_id: variantId }, [Modules.INVENTORY]: { inventory_item_id: { $ne: null } } },
          {}
        )
        const inventoryItemId = (itemLinks[0] as any).inventory_item_id as string
        const whLinks = await link.list(
          { [SUPPLIER_MODULE]: { supplier_warehouse_id: warehouse.id }, [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } } },
          {}
        )
        const stockLocationId = (whLinks[0] as any).stock_location_id as string
        const inventoryService = container().resolve(Modules.INVENTORY)
        await inventoryService.createReservationItems([
          { inventory_item_id: inventoryItemId, location_id: stockLocationId, quantity: 1, line_item_id: "external_consumer" },
        ])

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("RESERVATION_FAILED")
        expect(result.requiresReallocation).toBe(true)
      })

      it("tercer escenario: reserva funciona pero el proveedor dice no-stock en vivo -> NOT_READY + reserva compensada", async () => {
        const { cart, fakeAdapter } = await setupHappyPath("int3rdscenario")
        fakeAdapter.setLiveConfirmationBehavior({ mode: "reject" })
        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SUPPLIER_STOCK_REJECTED")

        const inventoryService = container().resolve(Modules.INVENTORY)
        const reservations = (await inventoryService.listReservationItems({})).filter((r: any) => !r.deleted_at)
        expect(reservations).toHaveLength(0)
      })

      it("cuarto escenario: todo funciona pero no hay tarifa -> NOT_READY + reserva liberada + SHIPPING_QUOTE_MISSING", async () => {
        const supplier = await createSupplier("exel_int_4th")
        const warehouse = await createWarehouse(supplier.id, "MY")
        const variantId = await createVariant("Variant Int4th")
        const mapping = await createMapping(supplier.id, variantId, "SKU-INT-4TH")
        await stockUp(mapping.id, supplier.id, warehouse.id, 10)
        await createDefaultPolicy("policy-int-4th")
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const cart = await createCart()
        await addLineItem(cart.id, variantId, 1, 123, "Variant Int4th")
        await setShippingAddress(cart.id)
        await allocate(cart.id, [{ variantId, quantity: 1 }])
        registerSupplierAdapters({ [supplier.adapter_key]: new FakeSupplierAdapter(supplier.adapter_key) })

        const result = await prepare(cart.id)
        expect(result.status).toBe("NOT_READY")
        expect(result.failureCode).toBe("SHIPPING_QUOTE_MISSING")

        const inventoryService = container().resolve(Modules.INVENTORY)
        const reservations = (await inventoryService.listReservationItems({})).filter((r: any) => !r.deleted_at)
        expect(reservations).toHaveLength(0)
      })
    })

    describe("Etapa 7 — guardas de alcance (qué NO se hace todavía)", () => {
      it("nunca marca el readiness como consumed (reservado para Etapa 10 -- Payment real)", async () => {
        const { cart } = await setupHappyPath("noconsumed")
        const result = await prepare(cart.id)
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const readiness = await checkoutGuardsService.retrieveCheckoutReadiness(result.readinessId)
        expect(readiness.status).not.toBe("consumed")
      })

      it("nunca construye un SyscomAdapter real -- el fixture multi-proveedor usa solo FakeSupplierAdapter", () => {
        const source = FakeSupplierAdapter.toString()
        expect(source).not.toMatch(/SyscomAdapter/)
      })
    })
  },
})
