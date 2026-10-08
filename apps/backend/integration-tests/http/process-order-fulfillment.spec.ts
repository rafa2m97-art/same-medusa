import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { asValue } from "@medusajs/framework/awilix"
import { createOrderWorkflow, createRegionsWorkflow } from "@medusajs/core-flows"
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
import { prepareCheckoutForPaymentWorkflow } from "../../src/modules/checkout-guards/workflows/prepare-checkout-for-payment"
import { SUPPLIER_ADAPTER_REGISTRY, MapSupplierAdapterRegistry } from "../../src/modules/checkout-guards/supplier-adapter-registry"
import { FakeSupplierAdapter } from "../../src/modules/checkout-guards/__fixtures__/fake-supplier-adapter"
import { PACKAGE_PLANNING_MODULE } from "../../src/modules/package-planning"
import type PackagePlanningModuleService from "../../src/modules/package-planning/service"
import { planAndQuoteShippingWorkflow } from "../../src/modules/package-planning/workflows/plan-and-quote-shipping"
import { seedCarrierLimits } from "../../src/modules/package-planning/seed-carrier-limits"
import { SHIPPING_RATE_PROVIDER } from "../../src/modules/package-planning/shipping-rate-provider-registry"
import { FakeShippingRateProvider, fakeRate } from "../../src/modules/package-planning/__fixtures__/fake-shipping-rate-provider"
import { SUPPLIER_FULFILLMENT_MODULE } from "../../src/modules/supplier-fulfillment"
import type SupplierFulfillmentModuleService from "../../src/modules/supplier-fulfillment/service"
import { processOrderFulfillmentWorkflow, getOrderFulfillmentSummary } from "../../src/modules/supplier-fulfillment/workflows/process-order-fulfillment"
import {
  retryLabelPurchaseWorkflow,
  retrySupplierSubmissionWorkflow,
  markWarehouseShipmentForManualReviewWorkflow,
  attachExternalLabelWorkflow,
  attachSupplierOrderReferenceWorkflow,
  cancelWarehouseShipmentWorkflow,
} from "../../src/modules/supplier-fulfillment/workflows/manual-intervention"
import { SHIPPING_LABEL_PROVIDER } from "../../src/modules/supplier-fulfillment/shipping-label-provider-registry"
import { FakeShippingLabelProvider } from "../../src/modules/supplier-fulfillment/__fixtures__/fake-shipping-label-provider"
import { EnviaLabelAdapter } from "../../src/integrations/fulfillment/envia/envia-label-adapter"
import {
  COMMERCE_AUDIT_EMITTER,
  InMemoryCommerceAuditEmitter,
} from "../../src/modules/commerce-audit/events"

jest.setTimeout(300000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const container = () => getContainer()

    // ---- Fixtures reutilizados de Etapas 2-8 (mismo patrón que sus propios specs) ----

    async function createVariant(title: string, sku?: string) {
      const productService = container().resolve(Modules.PRODUCT)
      const [product] = await productService.createProducts([{ title: `Product ${title}`, status: "draft" }])
      const [variant] = await productService.createProductVariants([
        { title, sku: sku ?? title, product_id: product.id, weight: 2, length: 20, width: 15, height: 10 },
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

    async function createCart() {
      const cartService = container().resolve(Modules.CART)
      return cartService.createCarts({ currency_code: "mxn" })
    }

    async function addLineItem(cartId: string, variantId: string, quantity: number, unitPrice: number, title: string) {
      const cartService = container().resolve(Modules.CART)
      const [item] = await cartService.addLineItems(cartId, [{ title, variant_id: variantId, quantity, unit_price: unitPrice }])
      return item
    }

    async function setShippingAddress(cartId: string, overrides: Record<string, unknown> = {}) {
      const cartService = container().resolve(Modules.CART)
      const updated = await cartService.updateCarts(cartId, {
        shipping_address: {
          first_name: "Cliente",
          last_name: "Prueba",
          address_1: "Av. Siempre Viva 123",
          address_2: "456",
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

    function registerRateProvider(provider: FakeShippingRateProvider) {
      container().register(SHIPPING_RATE_PROVIDER, asValue(provider))
    }

    async function planAndQuote(cartId: string) {
      const { result } = await planAndQuoteShippingWorkflow(container()).run({ input: { cartId } })
      return result
    }

    function registerSupplierAdapters(adaptersByKey: Record<string, FakeSupplierAdapter>) {
      container().register(
        SUPPLIER_ADAPTER_REGISTRY,
        asValue(new MapSupplierAdapterRegistry(new Map(Object.entries(adaptersByKey))))
      )
    }

    async function prepare(cartId: string) {
      const { result } = await prepareCheckoutForPaymentWorkflow(container()).run({ input: { cartId } })
      return result
    }

    function registerLabelProvider(provider: FakeShippingLabelProvider) {
      container().register(SHIPPING_LABEL_PROVIDER, asValue(provider))
    }

    /**
     * Etapa 9 asume `PAYMENT_CAPTURED` como un trigger FAKE (plan §8) --
     * no hay MITEC real todavía (Etapa 10). Este helper crea la Order
     * NATIVA real (vía `createOrderWorkflow`, el mismo que usa Medusa
     * para draft orders) a partir del carrito YA READY, y la liga al
     * Cart con el Module Link nativo `OrderCart` -- exactamente el
     * mismo link que `completeCartWorkflow` crearía, pero sin requerir
     * una sesión de pago real (eso es, deliberadamente, responsabilidad
     * de Etapa 10, no de este fixture).
     */
    async function completeOrderForCart(cartId: string): Promise<string> {
      const cartService = container().resolve(Modules.CART)
      const cart = await cartService.retrieveCart(cartId, { relations: ["items", "shipping_address"] })
      const address = cart.shipping_address as any

      const { result } = await createOrderWorkflow(container()).run({
        input: {
          email: "cliente@example.com",
          currency_code: cart.currency_code,
          region_id: mxnRegionId,
          shipping_address: {
            first_name: address.first_name,
            last_name: address.last_name,
            address_1: address.address_1,
            address_2: address.address_2,
            city: address.city,
            province: address.province,
            postal_code: address.postal_code,
            country_code: address.country_code,
            phone: address.phone,
          },
          // Deliberadamente SIN variant_id/product_id: createOrderWorkflow
          // valida que la variante pertenezca a un producto PUBLICADO (los
          // fixtures de este archivo, igual que los de Etapas 7/8, crean
          // productos en "draft") -- y el workflow de Etapa 9 nunca lee
          // Order.items de todas formas (usa PackageItem de package-planning
          // como única fuente real de variant_id/quantity por origen).
          items: (cart.items as any[]).map((i) => ({
            title: i.title,
            quantity: i.quantity,
            unit_price: i.unit_price,
          })),
        } as any,
      })

      const link = container().resolve(ContainerRegistrationKeys.LINK)
      await link.create([{ [Modules.ORDER]: { order_id: result.id }, [Modules.CART]: { cart_id: cartId } }])

      return result.id as string
    }

    async function runFulfillment(orderId: string) {
      const { result } = await processOrderFulfillmentWorkflow(container()).run({ input: { orderId } })
      return result
    }

    /**
     * Medusa serializa el error de un step que falla en un objeto plano
     * (no una instancia real de `Error`) para cruzar la frontera de la
     * transacción del motor de Workflows -- `expect(...).rejects.toThrow()`
     * no lo reconoce como "throw" de forma confiable contra ese objeto
     * plano (falso negativo confirmado empíricamente). Este helper
     * verifica el rechazo directamente, sin depender de `instanceof Error`.
     */
    async function expectRejects(promise: Promise<unknown>): Promise<void> {
      let threw = false
      try {
        await promise
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    }

    async function getShipments(orderId: string) {
      const fulfillmentService = container().resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
      return fulfillmentService.listWarehouseShipments({ order_id: orderId })
    }

    async function getShipment(id: string) {
      const fulfillmentService = container().resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
      return fulfillmentService.retrieveWarehouseShipment(id)
    }

    async function getEvents(warehouseShipmentId: string) {
      const fulfillmentService = container().resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
      return fulfillmentService.listWarehouseShipmentEvents({ warehouse_shipment_id: warehouseShipmentId }, { order: { occurred_at: "ASC" } })
    }

    let mxnRegionId: string

    beforeAll(async () => {
      const pricingService = container().resolve(Modules.PRICING)
      await pricingService.createPricePreferences({
        attribute: "currency_code",
        value: "mxn",
        is_tax_inclusive: true,
      })
      await seedCarrierLimits(container())

      // createOrderWorkflow (plan §8: trigger fake de PAYMENT_CAPTURED)
      // necesita una Region real para resolver region_id/moneda -- igual
      // que initial-data-seed.ts en producción real.
      const { result: regions } = await createRegionsWorkflow(container()).run({
        input: { regions: [{ name: "Mexico", currency_code: "mxn", countries: ["mx"], payment_providers: ["pp_system_default"] }] },
      })
      mxnRegionId = regions[0].id
    })

    beforeEach(() => {
      container().register(COMMERCE_AUDIT_EMITTER, asValue(new InMemoryCommerceAuditEmitter()))
    })

    /**
     * Construye UN origen completo: proveedor -> almacén -> variante ->
     * mapping -> stock -> pricing -> carrito -> allocation -> package
     * plan + quote (Etapa 8, fake rate provider) -- listo para
     * `prepare()`. No llama `prepare()` ni crea la Order todavía, para
     * que los tests multi-origen puedan combinar varios antes de hacerlo.
     */
    async function setupOrigin(label: string, opts: { warehouseCode?: string; rateAmount?: number } = {}) {
      const warehouseCode = opts.warehouseCode ?? "MY"
      const rateAmount = opts.rateAmount ?? 150
      const supplier = await createSupplier(`exel_${label}`)
      const warehouse = await createWarehouse(supplier.id, warehouseCode)
      const variantId = await createVariant(`Variant ${label}`)
      const mapping = await createMapping(supplier.id, variantId, `SKU-${label}`)
      await stockUp(mapping.id, supplier.id, warehouse.id, 10)
      await createDefaultPolicy(`policy-${label}`)
      await applySupplierPricingWorkflow(container()).run({
        input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
      })
      const fakeAdapter = new FakeSupplierAdapter(supplier.adapter_key)
      return { supplier, warehouse, variantId, mapping, fakeAdapter, rateAmount }
    }

    /** Camino feliz de UN solo origen, de punta a punta hasta la Order real -- listo para `runFulfillment()`. */
    async function setupSingleOriginReadyOrder(label: string) {
      const origin = await setupOrigin(label)
      const cart = await createCart()
      await addLineItem(cart.id, origin.variantId, 1, 123, `Variant ${label}`)
      await setShippingAddress(cart.id)
      await allocate(cart.id, [{ variantId: origin.variantId, quantity: 1 }])

      const fakeRateProvider = new FakeShippingRateProvider("fake-envia", {
        mode: "success",
        rates: [fakeRate({ carrierCode: "fedex", serviceCode: "FEDEX_GROUND", amount: origin.rateAmount, estimatedDeliveryDays: 3 })],
      })
      registerRateProvider(fakeRateProvider)
      await planAndQuote(cart.id)

      registerSupplierAdapters({ [origin.supplier.adapter_key]: origin.fakeAdapter })
      const prepared = await prepare(cart.id)
      if (prepared.status !== "READY") {
        throw new Error(`setupSingleOriginReadyOrder(${label}): checkout no quedó READY -- ${prepared.failureCode}`)
      }

      const orderId = await completeOrderForCart(cart.id)
      const fakeLabelProvider = new FakeShippingLabelProvider("fake-envia-label")
      registerLabelProvider(fakeLabelProvider)

      return { ...origin, cart, orderId, fakeLabelProvider }
    }

    /** Camino feliz MULTI-origen (2 proveedores distintos, mismo patrón que el multi-origen de Etapa 8) -- listo para `runFulfillment()`. */
    async function setupMultiOriginReadyOrder(label: string) {
      const originMY = await setupOrigin(`${label}my`, { warehouseCode: "MY", rateAmount: 150 })
      const originMX = await setupOrigin(`${label}mx`, { warehouseCode: "MX", rateAmount: 200 })

      const cart = await createCart()
      await addLineItem(cart.id, originMY.variantId, 1, 123, `Variant ${label} MY`)
      await addLineItem(cart.id, originMX.variantId, 1, 123, `Variant ${label} MX`)
      await setShippingAddress(cart.id)
      await allocate(cart.id, [
        { variantId: originMY.variantId, quantity: 1 },
        { variantId: originMX.variantId, quantity: 1 },
      ])

      const fakeRateProvider = new FakeShippingRateProvider("fake-envia", {
        mode: "success",
        rates: [fakeRate({ carrierCode: "fedex", serviceCode: "FEDEX_GROUND", amount: 150, estimatedDeliveryDays: 3 })],
      })
      registerRateProvider(fakeRateProvider)
      await planAndQuote(cart.id)

      registerSupplierAdapters({
        [originMY.supplier.adapter_key]: originMY.fakeAdapter,
        [originMX.supplier.adapter_key]: originMX.fakeAdapter,
      })
      const prepared = await prepare(cart.id)
      if (prepared.status !== "READY") {
        throw new Error(`setupMultiOriginReadyOrder(${label}): checkout no quedó READY -- ${prepared.failureCode}`)
      }

      const orderId = await completeOrderForCart(cart.id)
      const fakeLabelProvider = new FakeShippingLabelProvider("fake-envia-label")
      registerLabelProvider(fakeLabelProvider)

      return { originMY, originMX, cart, orderId, fakeLabelProvider }
    }

    describe("Etapa 9 — single-origin happy path (plan §2)", () => {
      it("crea 1 WarehouseShipment, compra 1 guía, envía 1 pedido al proveedor y llega a SUPPLIER_ACCEPTED", async () => {
        const { orderId, fakeAdapter, fakeLabelProvider, warehouse } = await setupSingleOriginReadyOrder("happy1")

        await runFulfillment(orderId)

        const shipments = await getShipments(orderId)
        expect(shipments).toHaveLength(1)
        const shipment = shipments[0]
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")
        expect(shipment.supplier_warehouse_id).toBe(warehouse.id)
        expect(shipment.tracking_number).toBeTruthy()
        expect(shipment.provider_shipment_id).toBeTruthy()
        expect(shipment.label_reference).toBeTruthy()
        expect(shipment.supplier_order_reference).toBe("fake-order")

        expect(fakeLabelProvider.callCountFor(shipment.id)).toBe(1)
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(shipment.id)).toBe(1)

        const summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("PROCESSING")
      })

      it("registra el lifecycle completo en WarehouseShipmentEvent, en orden", async () => {
        const { orderId } = await setupSingleOriginReadyOrder("happy2")
        await runFulfillment(orderId)

        const [shipment] = await getShipments(orderId)
        const events = await getEvents(shipment.id)
        const types = events.map((e) => e.event_type)
        expect(types).toEqual([
          "WAREHOUSE_SHIPMENT_CREATED",
          "LABEL_PURCHASE_STARTED",
          "LABEL_PURCHASED",
          "ALL_LABELS_READY",
          "SUPPLIER_ORDER_SUBMISSION_STARTED",
          "SUPPLIER_ORDER_ACCEPTED",
        ])
      })
    })

    describe("Etapa 9 — multi-origin independence (plan §3)", () => {
      it("crea exactamente 2 WarehouseShipment (uno por origen), cada uno con tracking/reference propios", async () => {
        const { originMY, originMX, orderId } = await setupMultiOriginReadyOrder("multi1")
        await runFulfillment(orderId)

        const shipments = await getShipments(orderId)
        expect(shipments).toHaveLength(2)
        const wsMY = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!
        expect(wsMY.status).toBe("SUPPLIER_ACCEPTED")
        expect(wsMX.status).toBe("SUPPLIER_ACCEPTED")
        expect(wsMY.tracking_number).toBeTruthy()
        expect(wsMX.tracking_number).toBeTruthy()
        expect(wsMY.tracking_number).not.toBe(wsMX.tracking_number)
        expect(wsMY.provider_shipment_id).not.toBe(wsMX.provider_shipment_id)

        const summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("PROCESSING")
      })

      it("un fallo de guía en MX nunca contamina el estado/attempt_count/tracking de MY", async () => {
        const { originMY, originMX, orderId, fakeLabelProvider } = await setupMultiOriginReadyOrder("multi2")
        fakeLabelProvider.setBehaviorForOrigin(`SAME ${originMX.warehouse.external_code}`, {
          mode: "error",
          errorCode: "LABEL_PROVIDER_UNAVAILABLE",
          sideEffectMayHaveOccurred: false,
        })

        await runFulfillment(orderId)

        const shipments = await getShipments(orderId)
        const wsMY = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!
        expect(wsMY.status).toBe("LABEL_PURCHASED")
        expect(wsMY.tracking_number).toBeTruthy()
        expect(wsMY.label_attempt_count).toBe(1)
        expect(wsMX.status).toBe("LABEL_FAILED_RETRYABLE")
        expect(wsMX.tracking_number).toBeNull()
        expect(wsMX.label_attempt_count).toBe(1)
      })
    })

    describe("Etapa 9 — barrier real: ALL labels ready (plan §4, CRÍTICO)", () => {
      it("mientras UN origen no tenga guía, NINGÚN origen (incluido el exitoso) se envía al proveedor", async () => {
        const { originMY, originMX, orderId, fakeLabelProvider } = await setupMultiOriginReadyOrder("barrier1")
        fakeLabelProvider.setBehaviorForOrigin(`SAME ${originMX.warehouse.external_code}`, {
          mode: "error",
          errorCode: "LABEL_PROVIDER_UNAVAILABLE",
          sideEffectMayHaveOccurred: false,
        })

        await runFulfillment(orderId)

        const shipments = await getShipments(orderId)
        const wsMY = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!
        expect(wsMY.status).toBe("LABEL_PURCHASED")
        expect(wsMX.status).toBe("LABEL_FAILED_RETRYABLE")

        expect(originMY.fakeAdapter.getSubmitFulfillmentOrderCallCount(wsMY.id)).toBe(0)
        expect(originMX.fakeAdapter.getSubmitFulfillmentOrderCallCount(wsMX.id)).toBe(0)

        const summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("PREPARING")
      })

      it("una vez que MX también consigue guía (retry manual), el barrier abre y AMBOS orígenes se envían exactamente una vez", async () => {
        const { originMY, originMX, orderId, fakeLabelProvider } = await setupMultiOriginReadyOrder("barrier2")
        fakeLabelProvider.setBehaviorForOrigin(`SAME ${originMX.warehouse.external_code}`, {
          mode: "error",
          errorCode: "LABEL_PROVIDER_UNAVAILABLE",
          sideEffectMayHaveOccurred: false,
        })
        await runFulfillment(orderId)

        let shipments = await getShipments(orderId)
        const wsMY1 = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX1 = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!
        expect(wsMY1.status).toBe("LABEL_PURCHASED")

        // MX se recupera -- un operador fuerza el retry (el backoff real
        // de 5 min todavía no habría pasado si solo se reintentara
        // automáticamente, igual que en producción real) y luego corre
        // el workflow de nuevo, ahora con éxito para ambos.
        fakeLabelProvider.setBehaviorForOrigin(`SAME ${originMX.warehouse.external_code}`, { mode: "success" })
        await retryLabelPurchaseWorkflow(container()).run({
          input: { warehouseShipmentId: wsMX1.id, actor: "admin@same.com.mx", reason: "Envia ya está disponible de nuevo" },
        })
        await runFulfillment(orderId)

        shipments = await getShipments(orderId)
        const wsMY2 = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX2 = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!
        expect(wsMY2.status).toBe("SUPPLIER_ACCEPTED")
        expect(wsMX2.status).toBe("SUPPLIER_ACCEPTED")

        // MY nunca se compró dos veces ni se reenvió dos veces, aunque
        // el workflow completo se corrió de nuevo por culpa de MX.
        expect(fakeLabelProvider.callCountFor(wsMY1.id)).toBe(1)
        expect(fakeLabelProvider.callCountFor(wsMX1.id)).toBe(2)
        expect(originMY.fakeAdapter.getSubmitFulfillmentOrderCallCount(wsMY1.id)).toBe(1)
        expect(originMX.fakeAdapter.getSubmitFulfillmentOrderCallCount(wsMX1.id)).toBe(1)
      })
    })

    /**
     * Nota de diseño (plan §7/§8/§27): el workflow persiste el resultado
     * de CADA side effect inmediatamente, dentro del mismo step, ANTES
     * de continuar (plan §48) -- nunca en batch al final. Por eso, desde
     * afuera (black-box), "el proceso muere justo después de persistir
     * X y se vuelve a invocar el workflow completo" es OBSERVACIONALMENTE
     * IDÉNTICO a "correr el workflow una vez más sobre el mismo Order":
     * en ambos casos el segundo run lee exactamente el mismo estado ya
     * persistido en la DB. Estos tests simulan el crash exactamente así
     * -- no matan el proceso de Jest, pero prueban la MISMA garantía
     * observable que un crash real ejercitaría.
     */
    describe("Etapa 9 — crash recovery (plan §7/§8)", () => {
      it("LABEL: tras persistir una guía comprada, re-ejecutar el workflow completo nunca la vuelve a comprar", async () => {
        const { orderId, fakeLabelProvider } = await setupSingleOriginReadyOrder("crashlabel")

        await runFulfillment(orderId)
        const [afterFirstRun] = await getShipments(orderId)
        expect(afterFirstRun.label_reference).toBeTruthy()
        expect(fakeLabelProvider.callCountFor(afterFirstRun.id)).toBe(1)

        await runFulfillment(orderId)

        expect(fakeLabelProvider.callCountFor(afterFirstRun.id)).toBe(1)
        const [afterSecondRun] = await getShipments(orderId)
        expect(afterSecondRun.label_reference).toBe(afterFirstRun.label_reference)
        expect(afterSecondRun.tracking_number).toBe(afterFirstRun.tracking_number)
      })

      it("SUPPLIER: tras que el proveedor acepte el pedido, re-ejecutar el workflow completo nunca lo reenvía", async () => {
        const { orderId, fakeAdapter } = await setupSingleOriginReadyOrder("crashsupplier")

        await runFulfillment(orderId)
        const [afterFirstRun] = await getShipments(orderId)
        expect(afterFirstRun.status).toBe("SUPPLIER_ACCEPTED")
        expect(afterFirstRun.supplier_order_reference).toBeTruthy()
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(afterFirstRun.id)).toBe(1)

        await runFulfillment(orderId)

        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(afterFirstRun.id)).toBe(1)
        const [afterSecondRun] = await getShipments(orderId)
        expect(afterSecondRun.supplier_order_reference).toBe(afterFirstRun.supplier_order_reference)
        expect(afterSecondRun.status).toBe("SUPPLIER_ACCEPTED")
      })
    })

    describe("Etapa 9 — side-effect ambiguous (plan §9/§10, CRÍTICO)", () => {
      it("LABEL: un timeout ambiguo va a REQUIRES_MANUAL_REVIEW y NUNCA se reintenta automáticamente", async () => {
        const { orderId, fakeLabelProvider } = await setupSingleOriginReadyOrder("ambiguouslabel")
        fakeLabelProvider.setBehavior({ mode: "error", errorCode: "LABEL_TIMEOUT", sideEffectMayHaveOccurred: true })

        await runFulfillment(orderId)

        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(shipment.requires_manual_review).toBe(true)
        expect(shipment.manual_review_reason).toMatch(/^AMBIGUOUS_LABEL_PURCHASE/)
        expect(fakeLabelProvider.callCountFor(shipment.id)).toBe(1)

        await runFulfillment(orderId)
        expect(fakeLabelProvider.callCountFor(shipment.id)).toBe(1)
        const [stillSame] = await getShipments(orderId)
        expect(stillSame.status).toBe("REQUIRES_MANUAL_REVIEW")
      })

      it("SUPPLIER: una excepción cruda (petición pudo haber llegado a Exel) va a REQUIRES_MANUAL_REVIEW y NUNCA reenvía el pedido", async () => {
        const { orderId, fakeAdapter } = await setupSingleOriginReadyOrder("ambiguoussupplier")
        fakeAdapter.setOrderSubmissionBehavior({ mode: "throw", message: "ETIMEDOUT" })

        await runFulfillment(orderId)

        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(shipment.manual_review_reason).toMatch(/^AMBIGUOUS_SUPPLIER_SUBMISSION/)
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(shipment.id)).toBe(1)

        await runFulfillment(orderId)
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(shipment.id)).toBe(1)
      })

      it("SUPPLIER: el modo 'timeout' tipado del fake (equivalente a Exel, sin idempotency key nativa) también es ambiguo", async () => {
        const { orderId, fakeAdapter } = await setupSingleOriginReadyOrder("ambiguoussupplier2")
        fakeAdapter.setOrderSubmissionBehavior({ mode: "timeout" })

        await runFulfillment(orderId)

        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(shipment.supplier_last_error_code).toBe("SUPPLIER_SUBMISSION_AMBIGUOUS")
      })
    })

    describe("Etapa 9 — production lock (plan §11)", () => {
      it("con el candado cerrado, el workflow NUNCA hace fetch() real -- bloquea ANTES del side effect, nunca después", async () => {
        const { orderId } = await setupSingleOriginReadyOrder("prodlock1")

        const fetchSpy = jest
          .spyOn(global, "fetch")
          .mockImplementation(() => Promise.reject(new Error("fetch() NUNCA debía llamarse -- el candado debe bloquear antes")))

        container().register(
          SHIPPING_LABEL_PROVIDER,
          asValue(
            new EnviaLabelAdapter({
              apiKey: "fake-key-nunca-usada",
              baseUrl: "https://api.envia.com",
              lockEnvironment: { enviaEnvironment: "production", labelPurchaseEnabledFlag: undefined, productionUnlockedFlag: undefined },
            })
          )
        )

        await runFulfillment(orderId)

        expect(fetchSpy).not.toHaveBeenCalled()
        const [shipment] = await getShipments(orderId)
        expect(shipment.label_reference).toBeNull()
        expect(shipment.status).toBe("LABEL_FAILED_RETRYABLE")
        expect(shipment.label_last_error_code).toBe("LABEL_PROVIDER_UNAVAILABLE")

        fetchSpy.mockRestore()
      })
    })

    describe("Etapa 9 — preconditions incorrectas (plan §12)", () => {
      it("CheckoutReadiness ya no 'ready' -> bloquea, sin crear ningún WarehouseShipment", async () => {
        const { orderId, cart } = await setupSingleOriginReadyOrder("precondready")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [readiness] = await checkoutGuardsService.listCheckoutReadinesses({ cart_id: cart.id })
        await checkoutGuardsService.updateCheckoutReadinesses([{ id: readiness.id, status: "superseded" }])

        await expectRejects(runFulfillment(orderId))
        expect(await getShipments(orderId)).toHaveLength(0)
      })

      it("PackagePlan ya superseded -> bloquea, sin crear ningún WarehouseShipment", async () => {
        const { orderId, warehouse } = await setupSingleOriginReadyOrder("precondplan")
        const packagePlanningService = container().resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
        const [plan] = await packagePlanningService.listPackagePlans({ supplier_warehouse_id: warehouse.id })
        await packagePlanningService.updatePackagePlans([{ id: plan.id, status: "superseded" }])

        await expectRejects(runFulfillment(orderId))
        expect(await getShipments(orderId)).toHaveLength(0)
      })

      it("ShippingSelection ya no 'selected' -> bloquea, sin crear ningún WarehouseShipment", async () => {
        const { orderId, cart } = await setupSingleOriginReadyOrder("precondselection")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        const [selection] = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id, status: "selected" })
        await checkoutGuardsService.updateShippingSelections([{ id: selection.id, status: "superseded" }])

        await expectRejects(runFulfillment(orderId))
        expect(await getShipments(orderId)).toHaveLength(0)
      })

      it("ShippingQuote ya no apunta al PackagePlan vigente -> bloquea, sin crear ningún WarehouseShipment", async () => {
        const { orderId, cart } = await setupSingleOriginReadyOrder("precondquote")
        const checkoutGuardsService = container().resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
        // Etapa 8 crea 3 ShippingQuote (cheapest/fastest/recommended) --
        // solo la ligada a la ShippingSelection SELECCIONADA es la que
        // `ensureWarehouseShipmentsStep` realmente usa; mutar cualquier
        // otra no tiene efecto (y NO probaría nada).
        const [selection] = await checkoutGuardsService.listShippingSelections({ cart_id: cart.id, status: "selected" })
        const [quote] = await checkoutGuardsService.listShippingQuotes({ shipping_selection_id: selection.id })
        await checkoutGuardsService.updateShippingQuotes([{ id: quote.id, package_plan_id: "pp_nonexistent" }])

        await expectRejects(runFulfillment(orderId))
        expect(await getShipments(orderId)).toHaveLength(0)
      })

      it("AllocationSnapshot ya no activa -> bloquea, sin crear ningún WarehouseShipment", async () => {
        const { orderId, cart } = await setupSingleOriginReadyOrder("precondallocation")
        const routingService = container().resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
        const [snapshot] = await routingService.listAllocationSnapshots({ cart_id: cart.id, status: "active" })
        await routingService.updateAllocationSnapshots([{ id: snapshot.id, status: "superseded" }])

        await expectRejects(runFulfillment(orderId))
        expect(await getShipments(orderId)).toHaveLength(0)
      })
    })

    describe("Etapa 9 — state machine enforcement (plan §13)", () => {
      it("rechaza attachExternalLabel() sobre un shipment que nunca llegó a REQUIRES_MANUAL_REVIEW, sin corromper su estado", async () => {
        const { orderId } = await setupSingleOriginReadyOrder("statemachine1")
        // Un WarehouseShipment solo existe una vez que el workflow corrió
        // al menos una vez (plan §2) -- el camino feliz completo llega a
        // SUPPLIER_ACCEPTED, que tampoco es REQUIRES_MANUAL_REVIEW, así
        // que sigue siendo un estado válido para probar el rechazo.
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")

        await expectRejects(
          attachExternalLabelWorkflow(container()).run({
            input: {
              warehouseShipmentId: shipment.id,
              actor: "admin@same.com.mx",
              reason: "intento inválido -- nunca estuvo en revisión",
              providerShipmentId: "x",
              trackingNumber: "y",
              labelReference: "z",
            },
          })
        )

        const [stillAccepted] = await getShipments(orderId)
        expect(stillAccepted.status).toBe("SUPPLIER_ACCEPTED")
        expect(stillAccepted.provider_shipment_id).not.toBe("x")
      })

      it("rechaza retrySupplierSubmission() sobre un shipment SUPPLIER_ACCEPTED (ya tiene reference) -- nunca reenvía un pedido aceptado", async () => {
        const { orderId } = await setupSingleOriginReadyOrder("statemachine2")
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")

        await expectRejects(
          retrySupplierSubmissionWorkflow(container()).run({
            input: { warehouseShipmentId: shipment.id, actor: "admin@same.com.mx", reason: "intento inválido" },
          })
        )

        const [stillAccepted] = await getShipments(orderId)
        expect(stillAccepted.status).toBe("SUPPLIER_ACCEPTED")
        expect(stillAccepted.supplier_order_reference).toBe(shipment.supplier_order_reference)
      })
    })

    describe("Etapa 9 — cost variance integrado (plan §15)", () => {
      it("costo real == costo cotizado -> ACCEPT, sigue normal hasta SUPPLIER_ACCEPTED", async () => {
        const { orderId, fakeLabelProvider } = await setupSingleOriginReadyOrder("costvariance-accept")
        fakeLabelProvider.setBehavior({ mode: "success", providerCostAmount: 150 })
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")
        expect(shipment.requires_manual_review).toBe(false)
      })

      it("variación intermedia (dentro de rejectVarianceRatio pero fuera de la tolerancia) -> REVIEW, guía conservada, nunca enviado al proveedor", async () => {
        const { orderId, fakeLabelProvider, fakeAdapter } = await setupSingleOriginReadyOrder("costvariance-review")
        // cotizado 150, real 250 -> variance = 100/150 = 0.667 (entre 0.2 y 1.0 => REVIEW)
        fakeLabelProvider.setBehavior({ mode: "success", providerCostAmount: 250 })
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(shipment.manual_review_reason).toBe("PROVIDER_COST_VARIANCE_REVIEW")
        expect(shipment.label_reference).toBeTruthy()
        expect(shipment.tracking_number).toBeTruthy()
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(shipment.id)).toBe(0)
      })

      it("variación grande (>100%) -> REJECT, pero la guía YA comprada nunca se descarta/revierte", async () => {
        const { orderId, fakeLabelProvider, fakeAdapter } = await setupSingleOriginReadyOrder("costvariance-reject")
        // cotizado 150, real 400 -> variance = 250/150 = 1.667 > 1.0 => REJECT
        fakeLabelProvider.setBehavior({ mode: "success", providerCostAmount: 400 })
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(shipment.manual_review_reason).toBe("PROVIDER_COST_VARIANCE_REJECT")
        expect(shipment.label_reference).toBeTruthy()
        expect(shipment.tracking_number).toBeTruthy()
        expect(shipment.provider_cost_amount).toBe(400)
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(shipment.id)).toBe(0)
      })
    })

    describe("Etapa 9 — manual intervention: attach external label (plan §19)", () => {
      it("tras una compra de guía ambigua, attachExternalLabel() recupera el shipment a LABEL_PURCHASED y el workflow continúa normal", async () => {
        const { orderId, fakeLabelProvider, fakeAdapter } = await setupSingleOriginReadyOrder("attachlabel")
        fakeLabelProvider.setBehavior({ mode: "error", errorCode: "LABEL_TIMEOUT", sideEffectMayHaveOccurred: true })
        await runFulfillment(orderId)

        const [ambiguous] = await getShipments(orderId)
        expect(ambiguous.status).toBe("REQUIRES_MANUAL_REVIEW")

        const { result } = await attachExternalLabelWorkflow(container()).run({
          input: {
            warehouseShipmentId: ambiguous.id,
            actor: "admin@same.com.mx",
            reason: "Envia confirmó por soporte que la guía sí se creó",
            providerShipmentId: "envia-confirmed-123",
            trackingNumber: "TRACK-CONFIRMED-123",
            labelReference: "https://storage.example.com/labels/confirmed-123.pdf",
            providerCostAmount: 150,
          },
        })
        expect(result.newStatus).toBe("LABEL_PURCHASED")

        const [recovered] = await getShipments(orderId)
        expect(recovered.status).toBe("LABEL_PURCHASED")
        expect(recovered.requires_manual_review).toBe(false)
        expect(recovered.provider_shipment_id).toBe("envia-confirmed-123")
        expect(recovered.tracking_number).toBe("TRACK-CONFIRMED-123")

        await runFulfillment(orderId)
        const [final] = await getShipments(orderId)
        expect(final.status).toBe("SUPPLIER_ACCEPTED")
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(final.id)).toBe(1)
      })

      it("exige actor y reason no vacíos", async () => {
        const { orderId, fakeLabelProvider } = await setupSingleOriginReadyOrder("attachlabel-noauth")
        fakeLabelProvider.setBehavior({ mode: "error", errorCode: "LABEL_TIMEOUT", sideEffectMayHaveOccurred: true })
        await runFulfillment(orderId)
        const [ambiguous] = await getShipments(orderId)

        await expectRejects(
          attachExternalLabelWorkflow(container()).run({
            input: {
              warehouseShipmentId: ambiguous.id,
              actor: "",
              reason: "",
              providerShipmentId: "x",
              trackingNumber: "y",
              labelReference: "z",
            },
          })
        )
      })
    })

    describe("Etapa 9 — manual intervention: attach supplier order reference (plan §20)", () => {
      it("tras un envío ambiguo al proveedor, attachSupplierOrderReference() recupera a SUPPLIER_ACCEPTED sin volver a enviar el pedido", async () => {
        const { orderId, fakeAdapter } = await setupSingleOriginReadyOrder("attachsupplier")
        fakeAdapter.setOrderSubmissionBehavior({ mode: "timeout" })
        await runFulfillment(orderId)

        const [ambiguous] = await getShipments(orderId)
        expect(ambiguous.status).toBe("REQUIRES_MANUAL_REVIEW")
        const callsBefore = fakeAdapter.getSubmitFulfillmentOrderCallCount(ambiguous.id)

        const { result } = await attachSupplierOrderReferenceWorkflow(container()).run({
          input: {
            warehouseShipmentId: ambiguous.id,
            actor: "admin@same.com.mx",
            reason: "Exel confirmó telefónicamente que el pedido sí se registró",
            supplierOrderReference: "EXEL-CONFIRMED-999",
          },
        })
        expect(result.newStatus).toBe("SUPPLIER_ACCEPTED")

        const [recovered] = await getShipments(orderId)
        expect(recovered.status).toBe("SUPPLIER_ACCEPTED")
        expect(recovered.supplier_order_reference).toBe("EXEL-CONFIRMED-999")
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(ambiguous.id)).toBe(callsBefore)
      })
    })

    describe("Etapa 9 — manual intervention: mark for review (plan §21)", () => {
      it("marca explícitamente un shipment para revisión manual, auditado con actor/reason", async () => {
        const { orderId } = await setupSingleOriginReadyOrder("markreview")
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")

        await markWarehouseShipmentForManualReviewWorkflow(container()).run({
          input: {
            warehouseShipmentId: shipment.id,
            actor: "admin@same.com.mx",
            reason: "Cliente reportó una dirección incorrecta -- requiere revisión antes de seguir",
          },
        })

        const [reviewed] = await getShipments(orderId)
        expect(reviewed.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(reviewed.manual_review_reason).toMatch(/dirección incorrecta/)

        const events = await getEvents(shipment.id)
        const reviewEvent = events.find((e) => e.event_type === "WAREHOUSE_SHIPMENT_MANUAL_REVIEW")
        expect(reviewEvent?.actor).toBe("admin@same.com.mx")
      })
    })

    describe("Etapa 9 — manual intervention: cancellation (plan §22)", () => {
      it("cancela localmente un shipment que nunca tuvo side effects externos", async () => {
        const { orderId, fakeLabelProvider } = await setupSingleOriginReadyOrder("cancelsafe")
        fakeLabelProvider.setBehavior({ mode: "error", errorCode: "LABEL_PROVIDER_UNAVAILABLE", sideEffectMayHaveOccurred: false })
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("LABEL_FAILED_RETRYABLE")
        expect(shipment.label_reference).toBeNull()

        const { result } = await cancelWarehouseShipmentWorkflow(container()).run({
          input: { warehouseShipmentId: shipment.id, actor: "admin@same.com.mx", reason: "Cliente canceló el pedido" },
        })
        expect(result.outcome).toBe("CANCELLED")

        const [cancelled] = await getShipments(orderId)
        expect(cancelled.status).toBe("CANCELLED")
        expect(cancelled.cancelled_at).toBeTruthy()
      })

      it("NUNCA finge cancelar un shipment con guía/pedido ya reales -- lo deja en REQUIRES_MANUAL_REVIEW explícito, conservando la evidencia", async () => {
        const { orderId } = await setupSingleOriginReadyOrder("cancelunsafe")
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")

        const { result } = await cancelWarehouseShipmentWorkflow(container()).run({
          input: { warehouseShipmentId: shipment.id, actor: "admin@same.com.mx", reason: "Cliente canceló el pedido" },
        })
        expect(result.outcome).toBe("CANCELLATION_REQUIRES_MANUAL_ACTION")

        const [stillHasEvidence] = await getShipments(orderId)
        expect(stillHasEvidence.status).toBe("REQUIRES_MANUAL_REVIEW")
        expect(stillHasEvidence.manual_review_reason).toMatch(/^CANCELLATION_REQUIRES_MANUAL_ACTION/)
        expect(stillHasEvidence.label_reference).toBeTruthy()
        expect(stillHasEvidence.supplier_order_reference).toBeTruthy()
      })
    })

    describe("Etapa 9 — order aggregate status integrado (plan §25)", () => {
      it("combinaciones reales de WarehouseShipment persistidos producen el agregado esperado", async () => {
        const fulfillmentService = container().resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
        const { originMY, originMX, orderId } = await setupMultiOriginReadyOrder("aggregate1")
        await runFulfillment(orderId)

        let shipments = await getShipments(orderId)
        let summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("PROCESSING")

        const wsMY = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!

        // MY shipped + MX todavía accepted -> PARTIALLY_SHIPPED (progreso
        // post-Etapa 9 simulado directo en DB -- transportar/entregar un
        // pedido todavía no es responsabilidad de esta etapa).
        await fulfillmentService.updateWarehouseShipments([{ id: wsMY.id, status: "SHIPPED" }])
        summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("PARTIALLY_SHIPPED")

        // ambos shipped -> SHIPPED
        await fulfillmentService.updateWarehouseShipments([{ id: wsMX.id, status: "SHIPPED" }])
        summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("SHIPPED")

        // ambos delivered -> DELIVERED
        await fulfillmentService.updateWarehouseShipments([
          { id: wsMY.id, status: "DELIVERED" },
          { id: wsMX.id, status: "DELIVERED" },
        ])
        summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("DELIVERED")

        // uno requiere revisión -> domina sobre todo lo demás
        await fulfillmentService.updateWarehouseShipments([
          { id: wsMY.id, status: "REQUIRES_MANUAL_REVIEW", requires_manual_review: true, manual_review_reason: "ajuste post-entrega" },
        ])
        summary = await getOrderFulfillmentSummary(container(), orderId)
        expect(summary.orderFulfillmentStatus).toBe("REQUIRES_ATTENTION")
      })
    })

    describe("Etapa 9 — event history: lifecycle ambiguo resuelto manualmente (plan §26)", () => {
      it("reconstruye: created -> label started -> manual review (ambiguo) -> label attached -> barrier -> supplier submit -> accepted", async () => {
        const { orderId, fakeLabelProvider } = await setupSingleOriginReadyOrder("eventhistory2")
        fakeLabelProvider.setBehavior({ mode: "error", errorCode: "LABEL_TIMEOUT", sideEffectMayHaveOccurred: true })
        await runFulfillment(orderId)

        const [shipment] = await getShipments(orderId)
        await attachExternalLabelWorkflow(container()).run({
          input: {
            warehouseShipmentId: shipment.id,
            actor: "admin@same.com.mx",
            reason: "Envia confirmó la guía por soporte",
            providerShipmentId: "envia-confirmed-456",
            trackingNumber: "TRACK-456",
            labelReference: "https://storage.example.com/labels/456.pdf",
          },
        })
        await runFulfillment(orderId)

        const events = await getEvents(shipment.id)
        expect(events.map((e) => e.event_type)).toEqual([
          "WAREHOUSE_SHIPMENT_CREATED",
          "LABEL_PURCHASE_STARTED",
          "WAREHOUSE_SHIPMENT_MANUAL_REVIEW",
          "LABEL_PURCHASED",
          "ALL_LABELS_READY",
          "SUPPLIER_ORDER_SUBMISSION_STARTED",
          "SUPPLIER_ORDER_ACCEPTED",
        ])
      })
    })

    describe("Etapa 9 — workflow rerun después de COMPLETE (plan §27)", () => {
      it("una Order ya completada -> rerun no genera llamadas externas ni eventos duplicados", async () => {
        const { orderId, fakeLabelProvider, fakeAdapter } = await setupSingleOriginReadyOrder("rerun-complete")
        await runFulfillment(orderId)
        const [shipment] = await getShipments(orderId)
        expect(shipment.status).toBe("SUPPLIER_ACCEPTED")
        const eventsBefore = await getEvents(shipment.id)

        await runFulfillment(orderId)
        await runFulfillment(orderId)

        const [stillSame] = await getShipments(orderId)
        expect(stillSame.status).toBe("SUPPLIER_ACCEPTED")
        expect(stillSame.supplier_order_reference).toBe(shipment.supplier_order_reference)
        expect(fakeLabelProvider.callCountFor(shipment.id)).toBe(1)
        expect(fakeAdapter.getSubmitFulfillmentOrderCallCount(shipment.id)).toBe(1)

        const eventsAfter = await getEvents(shipment.id)
        expect(eventsAfter.length).toBe(eventsBefore.length)
      })
    })

    describe("Etapa 9 — Exel mapping: SupplierOrderRequest normalizado por origen (plan §35)", () => {
      it("WS-MY recibe un SupplierOrderRequest con SOLO la clave de almacén y las líneas de MY, nunca mezcladas con MX", async () => {
        const { originMY, originMX, orderId } = await setupMultiOriginReadyOrder("exelmapping")
        await runFulfillment(orderId)

        const shipments = await getShipments(orderId)
        const wsMY = shipments.find((s) => s.supplier_warehouse_id === originMY.warehouse.id)!
        const wsMX = shipments.find((s) => s.supplier_warehouse_id === originMX.warehouse.id)!

        const requestMY = originMY.fakeAdapter.submitFulfillmentOrderRequests.find(
          (r) => r.warehouseShipmentId === wsMY.id
        )!
        const requestMX = originMX.fakeAdapter.submitFulfillmentOrderRequests.find(
          (r) => r.warehouseShipmentId === wsMX.id
        )!

        expect(requestMY.externalReferences?.warehouseExternalCode).toBe("MY")
        expect(requestMX.externalReferences?.warehouseExternalCode).toBe("MX")
        expect(requestMY.supplierWarehouseId).toBe(originMY.warehouse.id)
        expect(requestMX.supplierWarehouseId).toBe(originMX.warehouse.id)
        expect(requestMY.lines).toHaveLength(1)
        expect(requestMX.lines).toHaveLength(1)
        expect(requestMY.lines[0].supplierSku).toBe(originMY.mapping.supplier_sku)
        expect(requestMX.lines[0].supplierSku).toBe(originMX.mapping.supplier_sku)
        expect(requestMY.shipping?.trackingNumber).toBe(wsMY.tracking_number)
        expect(requestMX.shipping?.trackingNumber).toBe(wsMX.tracking_number)
        expect(requestMY.shipping?.trackingNumber).not.toBe(requestMX.shipping?.trackingNumber)
      })
    })
  },
})
