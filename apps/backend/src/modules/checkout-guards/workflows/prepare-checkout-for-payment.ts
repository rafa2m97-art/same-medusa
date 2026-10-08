import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../../supplier"
import type SupplierModuleService from "../../supplier/service"
import type { AllocationLineToConfirm } from "../../supplier/types"
import { PRICING_RULES_MODULE } from "../../pricing-rules"
import type PricingRulesModuleService from "../../pricing-rules/service"
import { WAREHOUSE_ROUTING_MODULE } from "../../warehouse-routing"
import type WarehouseRoutingModuleService from "../../warehouse-routing/service"
import { computeAllocationFingerprint } from "../../warehouse-routing/rules/fingerprint"
import { PACKAGE_PLANNING_MODULE } from "../../package-planning"
import type PackagePlanningModuleService from "../../package-planning/service"
import { CHECKOUT_GUARDS_MODULE } from "../index"
import type CheckoutGuardsModuleService from "../service"
import { resolveCommerceAuditEmitter } from "../../commerce-audit/events"
import { validateAllocationSnapshot } from "../rules/validate-allocation-snapshot"
import { evaluatePriceGuardLine } from "../rules/price-guard"
import { evaluateAddressCompleteness } from "../rules/address-guard"
import { evaluateShippingQuote } from "../rules/shipping-quote-guard"
import { evaluateCircuitBreaker } from "../rules/circuit-breaker"
import { planReservations, type DesiredReservation, type ExistingReservation } from "../rules/reservation-plan"
import {
  evaluateLiveSupplierConfirmations,
  type SupplierConfirmationOutcome,
} from "../rules/live-supplier-confirmation"
import { computeReadinessFingerprint } from "../rules/readiness-fingerprint"
import { resolveFailureRetryability, type CheckoutGuardFailure } from "../rules/taxonomy"
import { resolveSupplierAdapterRegistry } from "../supplier-adapter-registry"

/**
 * Coordinador de Etapa 7 (plan §28/§37). Orden elegido deliberadamente
 * de más barato/local a más costoso/externo, para no hacer trabajo
 * inútil (plan §37):
 *
 *   1. validar AllocationSnapshot (lectura local, barata)
 *   2. Price Guard (lectura local contra Pricing nativo)
 *   3. Reservation (escritura local, pero SOLO si 1-2 pasaron)
 *   4. Live Supplier Confirmation (red externa -- lo más costoso,
 *      nunca se llama si el stock local ya se sabe insuficiente)
 *   5. Address Guard (lectura local, barata -- después de la red
 *      porque una dirección incompleta es responsabilidad del
 *      cliente, no bloquea nada costoso si ya se va a fallar por
 *      proveedor/stock primero)
 *   6. Shipping Quote Guard (lectura local de una quote ya calculada
 *      -- Etapa 8 construye la cotización real; aquí solo se valida)
 *
 * Cada guard es un step independiente, testeable y explicable por sí
 * mismo (plan §2) -- nunca un `validateCheckout()` monolítico. El
 * "short-circuit" entre guards es por DATO (cada step recibe el
 * resultado del anterior y, si ya hay un `failure`, se vuelve un
 * pass-through sin volver a evaluar nada) -- no por control de flujo
 * del motor de Workflows (`when/then` para 6 pasos secuenciales habría
 * sido mucho más verboso sin ganar nada real).
 *
 * No implementa (plan §52): confirmAllocationLive() real contra Exel
 * real, compra de guía, cotización real de Envia, MITEC, SAP, cambios
 * al VPS. El resultado final es `READY`/`NOT_READY`, nunca un cobro.
 */

const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 300_000
const DEFAULT_READINESS_TTL_MS = 15 * 60 * 1000

export interface PrepareCheckoutForPaymentInput {
  cartId: string
  circuitBreakerCooldownMs?: number
  addressPhoneRequired?: boolean
}

interface CartItemContext {
  lineItemId: string
  variantId: string
  quantity: number
  unitPrice: number
}

interface GuardContext {
  cartId: string
  failure: CheckoutGuardFailure | null
  circuitBreakerCooldownMs: number
  addressPhoneRequired: boolean
  allocationSnapshotId: string | null
  cartFingerprint: string | null
  cartCurrencyCode: string | null
  cartItems: CartItemContext[]
  destinationState: string | null
  authorizedAmount: number | null
  reservationIds: string[]
  reservationStageReached: boolean
  supplierConfirmedAt: string | null
  shippingQuoteId: string | null
  shippingAmount: number | null
}

function withFailure(ctx: GuardContext, failure: CheckoutGuardFailure): GuardContext {
  return { ...ctx, failure }
}

/**
 * Carga Cart + AllocationSnapshot ACTIVE y corre el primer guard (plan
 * §4). Sin esto, ningún guard posterior tiene sentido -- nunca se
 * intenta "arreglar" un carrito cambiado, solo se reporta.
 */
const loadAndValidateAllocationStep = createStep(
  "load-and-validate-allocation",
  async (
    input: PrepareCheckoutForPaymentInput,
    { container }
  ): Promise<StepResponse<GuardContext, null>> => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const cartService = container.resolve(Modules.CART)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)

    auditEmitter.emit({
      eventType: "CHECKOUT_VALIDATION_STARTED",
      correlationId: input.cartId,
      details: {},
      occurredAt: new Date(),
    })

    const base: GuardContext = {
      cartId: input.cartId,
      failure: null,
      circuitBreakerCooldownMs: input.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
      addressPhoneRequired: input.addressPhoneRequired ?? true,
      allocationSnapshotId: null,
      cartFingerprint: null,
      cartCurrencyCode: null,
      cartItems: [],
      destinationState: null,
      authorizedAmount: null,
      reservationIds: [],
      reservationStageReached: false,
      supplierConfirmedAt: null,
      shippingQuoteId: null,
      shippingAmount: null,
    }

    const cart = await cartService.retrieveCart(input.cartId, {
      relations: ["items", "shipping_address"],
    })
    const cartItems: CartItemContext[] = (cart.items ?? []).map((item: any) => ({
      lineItemId: item.id as string,
      variantId: item.variant_id as string,
      quantity: item.quantity as number,
      unitPrice: Number(item.unit_price),
    }))
    const destinationState = (cart.shipping_address as any)?.province as string | null | undefined

    const [snapshot] = await routingService.listAllocationSnapshots({
      cart_id: input.cartId,
      status: "active",
    })

    if (!snapshot) {
      return new StepResponse(
        withFailure(
          { ...base, cartCurrencyCode: cart.currency_code, cartItems, destinationState: destinationState ?? null },
          {
            failureCode: "ALLOCATION_INVALID",
            failureStage: "ALLOCATION_VALIDATION",
            details: { reason: "no_active_snapshot" },
          }
        ),
        null
      )
    }

    const currentFingerprint = computeAllocationFingerprint({
      lines: cartItems.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
      destinationState: destinationState ?? null,
    })

    const validation = validateAllocationSnapshot({
      snapshotCartId: snapshot.cart_id,
      requestCartId: input.cartId,
      snapshotStatus: snapshot.status as "draft" | "active" | "expired" | "superseded" | "consumed" | "invalidated",
      snapshotExpiresAt: snapshot.expires_at,
      snapshotFingerprint: snapshot.input_fingerprint,
      currentFingerprint,
      now: new Date(),
    })

    const ctx: GuardContext = {
      ...base,
      allocationSnapshotId: snapshot.id,
      cartFingerprint: currentFingerprint,
      cartCurrencyCode: cart.currency_code,
      cartItems,
      destinationState: destinationState ?? null,
    }

    return new StepResponse(validation.valid ? ctx : withFailure(ctx, validation.failure), null)
  }
)

/**
 * Price Guard (plan §5/§7/§8) -- compara el precio YA aceptado por
 * Pricing (Etapa 5/5.1) contra el precio guardado en el carrito, para
 * CADA línea. Nunca recalcula margen/IVA -- solo lee
 * `pricingModule.calculatePrices()` (API nativa) y
 * `PricingState.last_classification`.
 */
const priceGuardStep = createStep(
  "price-guard",
  async (ctx: GuardContext, { container }): Promise<StepResponse<GuardContext, null>> => {
    if (ctx.failure) return new StepResponse(ctx, null)

    const auditEmitter = resolveCommerceAuditEmitter(container)
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const pricingService = container.resolve(Modules.PRICING)
    const pricingRulesService = container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)

    const variantIds = ctx.cartItems.map((item) => item.variantId)
    const priceSetLinks = await link.list(
      {
        [Modules.PRODUCT]: { variant_id: variantIds },
        [Modules.PRICING]: { price_set_id: { $ne: null } },
      },
      {}
    )
    const priceSetIdByVariantId = new Map(
      priceSetLinks.map((l: { variant_id: string; price_set_id: string }) => [l.variant_id, l.price_set_id])
    )
    const pricingStates = await pricingRulesService.listPricingStates({ variant_id: variantIds })
    const classificationByVariantId = new Map(
      pricingStates.map((s) => [s.variant_id, s.last_classification as "ACCEPT" | "REVIEW" | null])
    )

    let authorizedAmount = 0
    const failures: CheckoutGuardFailure[] = []

    for (const item of ctx.cartItems) {
      const priceSetId = priceSetIdByVariantId.get(item.variantId)
      let authoritativeUnitPrice: number | null = null
      let isCalculatedPriceTaxInclusive: boolean | null = null

      if (priceSetId) {
        const [calculated] = await pricingService.calculatePrices(
          { id: [priceSetId] },
          { context: { currency_code: ctx.cartCurrencyCode as string } }
        )
        if (calculated && calculated.calculated_amount != null) {
          authoritativeUnitPrice = Number(calculated.calculated_amount)
          isCalculatedPriceTaxInclusive = calculated.is_calculated_price_tax_inclusive ?? null
        }
      }

      const result = evaluatePriceGuardLine({
        variantId: item.variantId,
        cartUnitPrice: item.unitPrice,
        authoritativeUnitPrice,
        isCalculatedPriceTaxInclusive,
        lastPricingClassification: classificationByVariantId.get(item.variantId) ?? null,
      })

      if (!result.valid) {
        failures.push(result.failure)
      } else {
        authorizedAmount += result.authoritativeUnitPrice * item.quantity
      }
    }

    if (failures.length > 0) {
      const priority: CheckoutGuardFailure["failureCode"][] = [
        "PRICE_INVALID",
        "PRICE_REQUIRES_REVIEW",
        "PRICE_CHANGED",
      ]
      const chosen =
        failures.find((f) => f.failureCode === priority[0]) ??
        failures.find((f) => f.failureCode === priority[1]) ??
        failures[0]

      auditEmitter.emit({
        eventType: "PRICE_GUARD_FAILED",
        correlationId: ctx.cartId,
        details: { failures },
        occurredAt: new Date(),
      })

      return new StepResponse(
        withFailure(ctx, { ...chosen, details: { ...chosen.details, allFailures: failures } }),
        null
      )
    }

    return new StepResponse({ ...ctx, authorizedAmount }, null)
  }
)

interface ReservationStepResult {
  ctx: GuardContext
}

interface ReservationCompensationData {
  createdIds: string[]
  inventoryItemIds: string[]
}

/**
 * Stock/Reservation Guard (plan §9/§10/§11/§12/§13/§34) -- usa
 * `ReservationItem` NATIVO, respetando el StockLocation EXACTO que
 * definió Routing (Etapa 6), nunca "variant x cantidad" genérico.
 *
 * Concurrencia real (plan §34): se envuelve la creación con el módulo
 * de Locking nativo por `inventory_item_id` -- EXACTAMENTE el mismo
 * mecanismo que usa el step nativo `createReservationsStep`
 * (confirmado leyendo node_modules/@medusajs/core-flows) -- y
 * `createReservationItems` ya valida disponibilidad real
 * (`validateQuantityAtLocation: true` internamente), así que "dos
 * clientes, última unidad" se resuelve con el comportamiento REAL de
 * Inventory, nunca con una comparación propia de cantidades.
 *
 * Se llama directo al servicio (no al workflow nativo
 * `createReservationsWorkflow.runAsStep`) a propósito: un
 * `runAsStep()` no se puede envolver en try/catch dentro del
 * constructor del workflow (el motor lo ejecuta después, no en el
 * momento de definir el grafo) -- y este guard necesita capturar el
 * error real de "Not enough stock" para convertirlo en un
 * `RESERVATION_FAILED` normal, nunca un crash del workflow completo.
 */
const reservationGuardStep = createStep(
  "reservation-guard",
  async (
    ctx: GuardContext,
    { container }
  ): Promise<StepResponse<ReservationStepResult, ReservationCompensationData | null>> => {
    if (ctx.failure) return new StepResponse({ ctx }, null)

    const auditEmitter = resolveCommerceAuditEmitter(container)
    const inventoryService = container.resolve(Modules.INVENTORY)
    const locking = container.resolve(Modules.LOCKING)
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)

    const lines = await routingService.listAllocationLines({
      allocation_snapshot_id: ctx.allocationSnapshotId!,
    })
    const lineIds = lines.map((l) => l.id)
    const assignments = lineIds.length
      ? await routingService.listAllocationAssignments({ allocation_line_id: lineIds })
      : []
    const assignmentsByLineId = new Map<string, typeof assignments>()
    for (const a of assignments) {
      const arr = assignmentsByLineId.get(a.allocation_line_id) ?? []
      arr.push(a)
      assignmentsByLineId.set(a.allocation_line_id, arr)
    }

    const lineItemByVariantId = new Map(ctx.cartItems.map((item) => [item.variantId, item.lineItemId]))

    const variantIds = lines.map((l) => l.variant_id)
    const itemLinks = await link.list(
      {
        [Modules.PRODUCT]: { variant_id: variantIds },
        [Modules.INVENTORY]: { inventory_item_id: { $ne: null } },
      },
      {}
    )
    const inventoryItemIdByVariantId = new Map(
      itemLinks.map((l: { variant_id: string; inventory_item_id: string }) => [l.variant_id, l.inventory_item_id])
    )

    const desired: DesiredReservation[] = []
    for (const line of lines) {
      const lineItemId = lineItemByVariantId.get(line.variant_id)
      const inventoryItemId = inventoryItemIdByVariantId.get(line.variant_id)
      if (!lineItemId || !inventoryItemId) continue
      for (const assignment of assignmentsByLineId.get(line.id) ?? []) {
        desired.push({
          lineItemId,
          inventoryItemId,
          locationId: assignment.stock_location_id,
          quantity: assignment.quantity,
        })
      }
    }

    const allLineItemIds = [...new Set(desired.map((d) => d.lineItemId))]
    const existingRaw = allLineItemIds.length
      ? await inventoryService.listReservationItems({ line_item_id: allLineItemIds })
      : []
    const existing: ExistingReservation[] = existingRaw.map((r: any) => ({
      id: r.id as string,
      lineItemId: r.line_item_id as string,
      inventoryItemId: r.inventory_item_id as string,
      locationId: r.location_id as string,
      quantity: Number(r.quantity),
    }))

    const plan = planReservations(desired, existing)
    const lockingKeys = [...new Set(desired.map((d) => d.inventoryItemId))]
    const createdIds: string[] = []

    try {
      await locking.execute(lockingKeys, async () => {
        if (plan.toCreate.length) {
          const created = await inventoryService.createReservationItems(
            plan.toCreate.map((r) => ({
              line_item_id: r.lineItemId,
              inventory_item_id: r.inventoryItemId,
              location_id: r.locationId,
              quantity: r.quantity,
            }))
          )
          createdIds.push(...created.map((r: { id: string }) => r.id))
        }
        if (plan.toUpdate.length) {
          await inventoryService.updateReservationItems(plan.toUpdate)
        }
        if (plan.toRelease.length) {
          await inventoryService.deleteReservationItems(plan.toRelease)
        }
      })
    } catch (error) {
      if (error instanceof MedusaError && error.type === MedusaError.Types.NOT_ALLOWED) {
        return new StepResponse(
          {
            ctx: withFailure(
              { ...ctx, reservationStageReached: true },
              {
                failureCode: "RESERVATION_FAILED",
                failureStage: "RESERVATION",
                details: { reason: "insufficient_stock", message: error.message },
              }
            ),
          },
          null
        )
      }
      throw error
    }

    if (createdIds.length) {
      auditEmitter.emit({
        eventType: "RESERVATION_CREATED",
        correlationId: ctx.cartId,
        details: { reservationIds: createdIds },
        occurredAt: new Date(),
      })
    }

    const reservationIds = [...plan.toReuse, ...plan.toUpdate.map((u) => u.id), ...createdIds]

    return new StepResponse(
      {
        ctx: { ...ctx, reservationIds, reservationStageReached: true },
      },
      { createdIds, inventoryItemIds: lockingKeys }
    )
  },
  async (compensation, { container }) => {
    if (!compensation?.createdIds?.length) return
    const inventoryService = container.resolve(Modules.INVENTORY)
    const locking = container.resolve(Modules.LOCKING)
    await locking.execute(compensation.inventoryItemIds, async () => {
      await inventoryService.deleteReservationItems(compensation.createdIds)
    })
  }
)

/**
 * Live Supplier Confirmation (plan §14-§20) -- agrupa por proveedor,
 * resuelve el adapter vía el registro (nunca `new ExelAdapter()`
 * directo aquí), respeta el circuit breaker por proveedor, y confirma
 * EXACTAMENTE lo cotizado (warehouse/sku/cantidad de la
 * AllocationAssignment, nunca "¿tiene esto en algún lado?").
 */
const liveSupplierConfirmationStep = createStep(
  "live-supplier-confirmation",
  async (ctx: GuardContext, { container }): Promise<StepResponse<GuardContext, null>> => {
    if (ctx.failure) return new StepResponse(ctx, null)

    const auditEmitter = resolveCommerceAuditEmitter(container)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const checkoutGuardsService = container.resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
    const registry = resolveSupplierAdapterRegistry(container)

    const lines = await routingService.listAllocationLines({
      allocation_snapshot_id: ctx.allocationSnapshotId!,
    })
    const lineIds = lines.map((l) => l.id)
    const assignments = lineIds.length
      ? await routingService.listAllocationAssignments({ allocation_line_id: lineIds })
      : []
    const lineById = new Map(lines.map((l) => [l.id, l]))

    const supplierIds = [...new Set(assignments.map((a) => a.supplier_id))]
    const warehouseIds = [...new Set(assignments.map((a) => a.supplier_warehouse_id))]
    const [suppliers, warehouses] = await Promise.all([
      supplierService.listSuppliers({ id: supplierIds }),
      supplierService.listSupplierWarehouses({ id: warehouseIds }),
    ])
    const supplierById = new Map(suppliers.map((s) => [s.id, s]))
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]))

    const mappings = await supplierService.listSupplierProductMappings({
      variant_id: lines.map((l) => l.variant_id),
      supplier_id: supplierIds,
    })
    const mappingBySupplierAndVariant = new Map(mappings.map((m) => [`${m.supplier_id}::${m.variant_id}`, m]))

    const assignmentsBySupplier = new Map<string, typeof assignments>()
    for (const a of assignments) {
      const arr = assignmentsBySupplier.get(a.supplier_id) ?? []
      arr.push(a)
      assignmentsBySupplier.set(a.supplier_id, arr)
    }

    const now = new Date()
    const outcomes: SupplierConfirmationOutcome[] = []

    for (const [supplierId, supplierAssignments] of assignmentsBySupplier) {
      const supplier = supplierById.get(supplierId)
      if (!supplier) continue

      const [circuitState] = await checkoutGuardsService.listLiveConfirmationCircuitStates({
        integration_key: supplierId,
      })
      const breaker = evaluateCircuitBreaker(
        { lastFailureAt: circuitState?.opened_at ?? null },
        { cooldownMs: ctx.circuitBreakerCooldownMs, now }
      )

      if (breaker.open) {
        outcomes.push({ supplierId, status: "CIRCUIT_OPEN", reason: "circuit_open" })
        continue
      }

      const linesToConfirm: AllocationLineToConfirm[] = supplierAssignments.map((a) => {
        const line = lineById.get(a.allocation_line_id)!
        const warehouse = warehouseById.get(a.supplier_warehouse_id)
        const mapping = mappingBySupplierAndVariant.get(`${supplierId}::${line.variant_id}`)
        return {
          warehouseExternalCode: warehouse?.external_code ?? "",
          supplierSku: mapping?.supplier_sku ?? "",
          quantity: a.quantity,
        }
      })

      try {
        const adapter = registry.resolve(supplier.adapter_key)
        const result = await adapter.inventory.confirmAllocationLive(linesToConfirm)
        outcomes.push({ supplierId, status: result.status, reason: result.reason })

        if (result.status === "CONFIRMED") {
          if (circuitState) {
            await checkoutGuardsService.deleteLiveConfirmationCircuitStates([circuitState.id])
          }
        } else if (result.status === "UNAVAILABLE" || result.status === "ERROR" || result.status === "TIMEOUT") {
          if (circuitState) {
            await checkoutGuardsService.updateLiveConfirmationCircuitStates([
              { id: circuitState.id, opened_at: now },
            ])
          } else {
            await checkoutGuardsService.createLiveConfirmationCircuitStates({
              integration_key: supplierId,
              opened_at: now,
            })
          }
        }
        // REJECTED (el proveedor sí respondió, solo dice "no hay stock") NUNCA
        // abre el circuito -- es una respuesta de negocio válida, no una falla
        // de disponibilidad de la API (evidencia real: el circuito solo abre
        // en class-msl-exel-product-client.php cuando decode_response() falla).
      } catch (error) {
        const isTimeout = error instanceof Error && /timeout/i.test(error.message)
        const status = isTimeout ? "TIMEOUT" : "ERROR"
        outcomes.push({ supplierId, status, reason: (error as Error).message })
        if (circuitState) {
          await checkoutGuardsService.updateLiveConfirmationCircuitStates([{ id: circuitState.id, opened_at: now }])
        } else {
          await checkoutGuardsService.createLiveConfirmationCircuitStates({ integration_key: supplierId, opened_at: now })
        }
      }
    }

    const result = evaluateLiveSupplierConfirmations(outcomes)

    if (!result.allConfirmed) {
      auditEmitter.emit({
        eventType: result.failure.failureCode === "SUPPLIER_STOCK_REJECTED" ? "LIVE_STOCK_REJECTED" : "SUPPLIER_CONFIRMATION_UNAVAILABLE",
        correlationId: ctx.cartId,
        details: { outcomes },
        occurredAt: now,
      })
      return new StepResponse(withFailure(ctx, result.failure), null)
    }

    auditEmitter.emit({
      eventType: "LIVE_STOCK_CONFIRMED",
      correlationId: ctx.cartId,
      details: { outcomes },
      occurredAt: now,
    })

    return new StepResponse({ ...ctx, supplierConfirmedAt: now.toISOString() }, null)
  }
)

/** Address Guard (plan §21/§22) -- campos nativos de `cart_address`, nunca estructura inventada. */
const addressGuardStep = createStep(
  "address-guard",
  async (ctx: GuardContext, { container }): Promise<StepResponse<GuardContext, null>> => {
    if (ctx.failure) return new StepResponse(ctx, null)

    const auditEmitter = resolveCommerceAuditEmitter(container)
    const cartService = container.resolve(Modules.CART)
    const cart = await cartService.retrieveCart(ctx.cartId, { relations: ["shipping_address"] })
    const address = cart.shipping_address as any

    const result = evaluateAddressCompleteness(
      {
        address1: (address?.address_1 as string) ?? null,
        city: (address?.city as string) ?? null,
        province: (address?.province as string) ?? null,
        postalCode: (address?.postal_code as string) ?? null,
        countryCode: (address?.country_code as string) ?? null,
        phone: (address?.phone as string) ?? null,
      },
      { phoneRequired: ctx.addressPhoneRequired }
    )

    if (!result.valid) {
      auditEmitter.emit({
        eventType: "ADDRESS_GUARD_FAILED",
        correlationId: ctx.cartId,
        details: result.failure.details ?? {},
        occurredAt: new Date(),
      })
      return new StepResponse(withFailure(ctx, result.failure), null)
    }

    return new StepResponse(ctx, null)
  }
)

/**
 * Shipping Quote Guard (plan §23/§26/§27) -- extendido en Etapa 8
 * (plan §20) para leer una `ShippingSelection` COMPLETA (una quote por
 * origen, nunca una sola quote suelta cuando la allocation es
 * multi-origen) en vez de una `ShippingQuote` individual. Cada quote
 * de la selección pasa por el MISMO guard puro de Etapa 7
 * (`evaluateShippingQuote`, sin cambios) -- si CUALQUIERA falla, toda
 * la selección se considera inválida (mismo principio "todas las
 * confirmaciones requeridas" que Live Supplier Confirmation).
 */
const shippingQuoteGuardStep = createStep(
  "shipping-quote-guard",
  async (ctx: GuardContext, { container }): Promise<StepResponse<GuardContext, null>> => {
    if (ctx.failure) return new StepResponse(ctx, null)

    const auditEmitter = resolveCommerceAuditEmitter(container)
    const checkoutGuardsService = container.resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
    const now = new Date()

    const [selection] = await checkoutGuardsService.listShippingSelections({
      cart_id: ctx.cartId,
      status: "selected",
    })

    if (!selection) {
      const failure = {
        failureCode: "SHIPPING_QUOTE_MISSING" as const,
        failureStage: "SHIPPING_QUOTE_GUARD" as const,
      }
      auditEmitter.emit({
        eventType: "SHIPPING_QUOTE_INVALID",
        correlationId: ctx.cartId,
        details: {},
        occurredAt: now,
      })
      return new StepResponse(withFailure(ctx, failure), null)
    }

    if (selection.allocation_snapshot_id !== ctx.allocationSnapshotId) {
      const failure = {
        failureCode: "SHIPPING_QUOTE_ALLOCATION_MISMATCH" as const,
        failureStage: "SHIPPING_QUOTE_GUARD" as const,
        details: { selectionAllocationSnapshotId: selection.allocation_snapshot_id },
      }
      auditEmitter.emit({ eventType: "SHIPPING_QUOTE_INVALID", correlationId: ctx.cartId, details: failure.details, occurredAt: now })
      return new StepResponse(withFailure(ctx, failure), null)
    }

    if (selection.expires_at && now.getTime() >= selection.expires_at.getTime()) {
      const failure = { failureCode: "SHIPPING_QUOTE_EXPIRED" as const, failureStage: "SHIPPING_QUOTE_GUARD" as const }
      auditEmitter.emit({ eventType: "SHIPPING_QUOTE_INVALID", correlationId: ctx.cartId, details: {}, occurredAt: now })
      return new StepResponse(withFailure(ctx, failure), null)
    }

    const quotes = await checkoutGuardsService.listShippingQuotes({ shipping_selection_id: selection.id })
    if (quotes.length === 0) {
      const failure = { failureCode: "SHIPPING_QUOTE_MISSING" as const, failureStage: "SHIPPING_QUOTE_GUARD" as const }
      auditEmitter.emit({ eventType: "SHIPPING_QUOTE_INVALID", correlationId: ctx.cartId, details: {}, occurredAt: now })
      return new StepResponse(withFailure(ctx, failure), null)
    }

    // Etapa 8: una quote puede seguir con allocation_snapshot_id correcto
    // pero apuntar a un PackagePlan que ya fue re-empacado/superseded (ej.
    // una dimensión de producto se corrigió y se volvió a planear) -- sin
    // este chequeo, esa quote vieja pasaría el guard de arriba sin que
    // nada la detecte. Nunca se confía en una quote cuyo PackagePlan no
    // esté activo, aunque la allocation en sí no haya cambiado.
    const packagePlanningService = container.resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
    const packagePlanIds = [...new Set(quotes.map((q) => q.package_plan_id).filter((id): id is string => !!id))]
    const activePackagePlans = packagePlanIds.length
      ? await packagePlanningService.listPackagePlans({ id: packagePlanIds, status: "active" })
      : []
    const activePackagePlanIds = new Set(activePackagePlans.map((p) => p.id))
    const stalePackagePlanQuote = quotes.find((q) => q.package_plan_id && !activePackagePlanIds.has(q.package_plan_id))
    if (stalePackagePlanQuote) {
      const failure = {
        failureCode: "SHIPPING_QUOTE_PACKAGE_PLAN_MISMATCH" as const,
        failureStage: "SHIPPING_QUOTE_GUARD" as const,
        details: { packagePlanId: stalePackagePlanQuote.package_plan_id },
      }
      auditEmitter.emit({ eventType: "SHIPPING_QUOTE_INVALID", correlationId: ctx.cartId, details: failure.details, occurredAt: now })
      return new StepResponse(withFailure(ctx, failure), null)
    }

    let totalAmount = 0
    for (const quote of quotes) {
      const result = evaluateShippingQuote({
        quote: {
          status: quote.status as "active" | "expired" | "consumed",
          expiresAt: quote.expires_at,
          allocationSnapshotId: quote.allocation_snapshot_id,
          amount: quote.amount === null ? null : Number(quote.amount),
          currencyCode: quote.currency_code,
          isFreeShipping: quote.is_free_shipping,
        },
        currentAllocationSnapshotId: ctx.allocationSnapshotId!,
        cartCurrencyCode: ctx.cartCurrencyCode!,
        now,
      })

      if (!result.valid) {
        auditEmitter.emit({
          eventType: "SHIPPING_QUOTE_INVALID",
          correlationId: ctx.cartId,
          details: { packagePlanId: quote.package_plan_id, ...(result.failure.details ?? {}) },
          occurredAt: now,
        })
        return new StepResponse(withFailure(ctx, result.failure), null)
      }
      totalAmount += result.amount
    }

    return new StepResponse({ ...ctx, shippingQuoteId: selection.id, shippingAmount: totalAmount }, null)
  }
)

export interface PrepareCheckoutForPaymentResult {
  status: "READY" | "NOT_READY"
  readinessId: string
  failureCode?: string
  failureStage?: string
  details?: Record<string, unknown>
  retryable?: boolean
  requiresReallocation?: boolean
  customerActionRequired?: boolean
  authorizedAmount?: number
  currencyCode?: string
}

/**
 * Último step: decide READY/NOT_READY, libera reservas si la falla
 * ocurrió DESPUÉS de reservar (plan §12 -- nunca dejar reservas
 * huérfanas de un intento que no llegó a pagar), y persiste
 * `CheckoutReadiness` (plan §29/§30/§31) con TTL explícito -- nunca un
 * booleano suelto.
 */
const finalizeReadinessStep = createStep(
  "finalize-readiness",
  async (ctx: GuardContext, { container }) => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const checkoutGuardsService = container.resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
    const inventoryService = container.resolve(Modules.INVENTORY)
    const locking = container.resolve(Modules.LOCKING)

    // Supersede cualquier readiness READY anterior de este carrito --
    // mismo patrón que AllocationSnapshot (Etapa 6): nunca se borra
    // historial, solo se marca superseded.
    const [previousReady] = await checkoutGuardsService.listCheckoutReadinesses({
      cart_id: ctx.cartId,
      status: "ready",
    })
    if (previousReady) {
      await checkoutGuardsService.updateCheckoutReadinesses([{ id: previousReady.id, status: "superseded" }])
    }

    if (ctx.failure) {
      // Si ya se reservó algo en ESTE intento y un guard POSTERIOR
      // falló, esas reservas quedarían huérfanas -- se liberan
      // explícitamente (plan §12), nunca se dejan "por si acaso".
      if (ctx.reservationStageReached && ctx.reservationIds.length > 0 && ctx.failure.failureStage !== "RESERVATION") {
        const reservations = await inventoryService.listReservationItems({ id: ctx.reservationIds })
        const inventoryItemIds = [...new Set(reservations.map((r: { inventory_item_id: string }) => r.inventory_item_id))]
        await locking.execute(inventoryItemIds, async () => {
          await inventoryService.deleteReservationItems(ctx.reservationIds)
        })
        auditEmitter.emit({
          eventType: "RESERVATION_RELEASED",
          correlationId: ctx.cartId,
          details: { reservationIds: ctx.reservationIds, reason: ctx.failure!.failureCode },
          occurredAt: new Date(),
        })
      }

      const retryability = resolveFailureRetryability(ctx.failure.failureCode)
      const readiness = await checkoutGuardsService.createCheckoutReadinesses({
        cart_id: ctx.cartId,
        status: "not_ready",
        allocation_snapshot_id: ctx.allocationSnapshotId,
        fingerprint: ctx.cartFingerprint ?? "",
        failure_code: ctx.failure.failureCode,
        failure_stage: ctx.failure.failureStage,
        failure_details: ctx.failure.details ?? null,
        retryable: retryability.retryable,
        requires_reallocation: retryability.requiresReallocation,
        customer_action_required: retryability.customerActionRequired,
      })

      auditEmitter.emit({
        eventType: "CHECKOUT_READINESS_INVALIDATED",
        correlationId: ctx.cartId,
        details: { failureCode: ctx.failure.failureCode, failureStage: ctx.failure.failureStage },
        occurredAt: new Date(),
      })

      const result: PrepareCheckoutForPaymentResult = {
        status: "NOT_READY",
        readinessId: readiness.id,
        failureCode: ctx.failure.failureCode,
        failureStage: ctx.failure.failureStage,
        details: ctx.failure.details,
        retryable: retryability.retryable,
        requiresReallocation: retryability.requiresReallocation,
        customerActionRequired: retryability.customerActionRequired,
      }
      return new StepResponse(result, null)
    }

    const authorizedAmount = (ctx.authorizedAmount ?? 0) + (ctx.shippingAmount ?? 0)
    const fingerprint = computeReadinessFingerprint({
      cartFingerprint: ctx.cartFingerprint ?? "",
      allocationSnapshotId: ctx.allocationSnapshotId ?? "",
      authorizedAmount,
      currencyCode: ctx.cartCurrencyCode ?? "",
      shippingQuoteId: ctx.shippingQuoteId ?? "",
      reservationIds: ctx.reservationIds,
      supplierConfirmedAt: ctx.supplierConfirmedAt,
    })

    const readiness = await checkoutGuardsService.createCheckoutReadinesses({
      cart_id: ctx.cartId,
      status: "ready",
      allocation_snapshot_id: ctx.allocationSnapshotId,
      fingerprint,
      authorized_amount: authorizedAmount,
      currency_code: ctx.cartCurrencyCode,
      shipping_quote_id: ctx.shippingQuoteId,
      supplier_confirmed_at: ctx.supplierConfirmedAt ? new Date(ctx.supplierConfirmedAt) : null,
      requires_reallocation: false,
      customer_action_required: false,
      expires_at: new Date(Date.now() + DEFAULT_READINESS_TTL_MS),
    })

    auditEmitter.emit({
      eventType: "CHECKOUT_READY_FOR_PAYMENT",
      correlationId: ctx.cartId,
      details: { readinessId: readiness.id, authorizedAmount },
      occurredAt: new Date(),
    })

    const result: PrepareCheckoutForPaymentResult = {
      status: "READY",
      readinessId: readiness.id,
      authorizedAmount,
      currencyCode: ctx.cartCurrencyCode ?? undefined,
    }
    return new StepResponse(result, null)
  }
)

export const prepareCheckoutForPaymentWorkflow = createWorkflow(
  "prepare-checkout-for-payment",
  (input: PrepareCheckoutForPaymentInput) => {
    const afterAllocation = loadAndValidateAllocationStep(input)
    const afterPrice = priceGuardStep(afterAllocation)
    const afterReservation = reservationGuardStep(afterPrice)
    const afterSupplierConfirmation = liveSupplierConfirmationStep(afterReservation.ctx)
    const afterAddress = addressGuardStep(afterSupplierConfirmation)
    const afterShipping = shippingQuoteGuardStep(afterAddress)
    const result = finalizeReadinessStep(afterShipping)

    return new WorkflowResponse(result)
  }
)
