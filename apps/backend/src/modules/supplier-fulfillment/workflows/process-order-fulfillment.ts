import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../../supplier"
import type SupplierModuleService from "../../supplier/service"
import type { SupplierOrderRequest } from "../../supplier/types"
import { WAREHOUSE_ROUTING_MODULE } from "../../warehouse-routing"
import type WarehouseRoutingModuleService from "../../warehouse-routing/service"
import { PACKAGE_PLANNING_MODULE } from "../../package-planning"
import type PackagePlanningModuleService from "../../package-planning/service"
import { CHECKOUT_GUARDS_MODULE } from "../../checkout-guards"
import type CheckoutGuardsModuleService from "../../checkout-guards/service"
import { SUPPLIER_FULFILLMENT_MODULE } from "../index"
import type SupplierFulfillmentModuleService from "../service"
import { resolveShippingLabelProvider } from "../shipping-label-provider-registry"
import { resolveSupplierAdapterRegistry } from "../../checkout-guards/supplier-adapter-registry"
import type { WarehouseShipmentStatus } from "../rules/state-machine"
import { allLabelsReady } from "../rules/all-labels-ready"
import { deriveOrderFulfillmentStatus } from "../rules/order-aggregate-status"
import { evaluateRetryEligibility } from "../rules/retry-eligibility"
import { evaluateProviderCostVariance, type ProviderCostVariancePolicy } from "../rules/provider-cost-variance"
import type { PurchaseShippingLabelRequest } from "../types"
import { assertValidTransition, emitEvent, resolveCartIdForOrder } from "./shared"
import { resolveFulfillmentErrorProfile } from "../rules/error-taxonomy"

/**
 * Coordinador de Etapa 9 (plan §46). Cinco steps independientes y
 * testeables por separado, nunca un método monolítico:
 *
 *   1. ensureWarehouseShipmentsStep  -- crea (idempotente) 1 shipment por origen.
 *   2. purchaseMissingLabelsStep     -- compra guías pendientes/retryables.
 *   3. checkAllLabelsReadyStep       -- abre el barrier (plan §20/§21).
 *   4. submitPendingSupplierOrdersStep -- envía al proveedor SOLO si el barrier abrió.
 *   5. (transform) deriveOrderFulfillmentStatus -- SOLO lectura, nunca persistido aparte.
 *
 * Trigger (plan §8): este workflow NO verifica pago -- asume que el
 * caller (un test, o el futuro subscriber de pago de Etapa 10) ya
 * confirmó `PAYMENT_CAPTURED` antes de invocarlo. Nunca se dispara
 * solo porque `CheckoutReadiness` esté `ready` (eso es ANTES de pagar).
 */

const DEFAULT_PROVIDER_COST_VARIANCE_POLICY: ProviderCostVariancePolicy = {
  maxAcceptableVarianceRatio: 0.2,
  rejectVarianceRatio: 1.0,
}

export interface ProcessOrderFulfillmentInput {
  orderId: string
}

export interface ProcessOrderFulfillmentResult {
  orderId: string
  orderFulfillmentStatus: string
  shipments: Array<{
    id: string
    supplierId: string
    supplierWarehouseId: string
    status: WarehouseShipmentStatus
  }>
}

/**
 * Step 1 (plan §9/§10/§11) -- preconditions + creación idempotente.
 * NUNCA recalcula Routing/Package Planning/shipping -- solo lee lo ya
 * congelado y, si falta, falla explícito en vez de inventar nada.
 */
const ensureWarehouseShipmentsStep = createStep(
  "ensure-warehouse-shipments",
  async (input: ProcessOrderFulfillmentInput, { container }) => {
    const checkoutGuardsService = container.resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
    const packagePlanningService = container.resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)

    const cartId = await resolveCartIdForOrder(container, input.orderId)
    if (!cartId) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `No se encontró un Cart ligado a la Order ${input.orderId}`)
    }

    const [readiness] = await checkoutGuardsService.listCheckoutReadinesses({ cart_id: cartId, status: "ready" })
    if (!readiness) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `No hay un CheckoutReadiness 'ready' para el carrito ${cartId} -- Etapa 9 nunca recalcula guards, solo verifica que ya pasaron.`
      )
    }

    const [snapshot] = await routingService.listAllocationSnapshots({ cart_id: cartId, status: "active" })
    if (!snapshot) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `No hay AllocationSnapshot activa para el carrito ${cartId}`)
    }

    const [selection] = await checkoutGuardsService.listShippingSelections({ cart_id: cartId, status: "selected" })
    if (!selection) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `No hay ShippingSelection seleccionada para el carrito ${cartId}`)
    }

    const plans = await packagePlanningService.listPackagePlans({
      allocation_snapshot_id: snapshot.id,
      status: "active",
    })
    if (plans.length === 0) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `No hay PackagePlan activo para la allocation ${snapshot.id}`)
    }

    const quotes = await checkoutGuardsService.listShippingQuotes({ shipping_selection_id: selection.id })
    const quoteByPackagePlanId = new Map(quotes.map((q) => [q.package_plan_id, q]))

    const createdOrReused: Array<{ id: string; supplierId: string; supplierWarehouseId: string; status: WarehouseShipmentStatus }> = []

    for (const plan of plans) {
      const [existing] = await fulfillmentService.listWarehouseShipments({
        order_id: input.orderId,
        supplier_id: plan.supplier_id,
        supplier_warehouse_id: plan.supplier_warehouse_id,
      })
      if (existing) {
        createdOrReused.push({
          id: existing.id,
          supplierId: existing.supplier_id,
          supplierWarehouseId: existing.supplier_warehouse_id,
          status: existing.status as WarehouseShipmentStatus,
        })
        continue
      }

      const quote = quoteByPackagePlanId.get(plan.id)
      if (!quote) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `No hay ShippingQuote seleccionada para el PackagePlan ${plan.id} (origen ${plan.supplier_warehouse_id})`
        )
      }

      const created = await fulfillmentService.createWarehouseShipments({
        order_id: input.orderId,
        allocation_snapshot_id: snapshot.id,
        supplier_id: plan.supplier_id,
        supplier_warehouse_id: plan.supplier_warehouse_id,
        package_plan_id: plan.id,
        shipping_selection_id: selection.id,
        shipping_quote_id: quote.id,
        carrier_code: quote.carrier_code ?? quote.carrier_name,
        service_code: quote.service_code,
        status: "READY_FOR_LABEL",
      })

      await emitEvent(container, created.id, "WAREHOUSE_SHIPMENT_CREATED", {
        orderId: input.orderId,
        supplierId: plan.supplier_id,
        supplierWarehouseId: plan.supplier_warehouse_id,
      })

      createdOrReused.push({
        id: created.id,
        supplierId: created.supplier_id,
        supplierWarehouseId: created.supplier_warehouse_id,
        status: created.status as WarehouseShipmentStatus,
      })
    }

    return new StepResponse({ orderId: input.orderId, shipments: createdOrReused }, null)
  }
)

/**
 * Step 2 (plan §12-§18/§45/§48) -- compra guías pendientes/retryables,
 * UNA por UNA, persistiendo inmediatamente tras cada side effect real
 * (plan §48/§49: "crash recovery" -- un crash entre compras no repite
 * las ya persistidas, porque cada una ya quedó guardada antes de
 * intentar la siguiente).
 */
const purchaseMissingLabelsStep = createStep(
  "purchase-missing-labels",
  async (ctx: { orderId: string; shipments: Array<{ id: string }> }, { container }) => {
    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const packagePlanningService = container.resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
    const checkoutGuardsService = container.resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
    const fileService = container.resolve(Modules.FILE)
    const orderService = container.resolve(Modules.ORDER)
    const provider = resolveShippingLabelProvider(container)

    const order = await orderService.retrieveOrder(ctx.orderId, { relations: ["shipping_address"] })
    const address = order.shipping_address as any

    const now = new Date()

    for (const shipmentRef of ctx.shipments) {
      const shipment = await fulfillmentService.retrieveWarehouseShipment(shipmentRef.id)
      const eligibleStatuses: WarehouseShipmentStatus[] = ["READY_FOR_LABEL", "LABEL_FAILED_RETRYABLE"]
      if (!eligibleStatuses.includes(shipment.status as WarehouseShipmentStatus)) continue

      const retryPolicy = { maxAttempts: 3, backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000], nonRetryableErrorCodes: [] }
      const eligibility = evaluateRetryEligibility({
        attemptCount: shipment.label_attempt_count,
        lastAttemptAt: shipment.label_last_attempt_at,
        lastErrorCode: shipment.label_last_error_code,
        retryPolicy,
        now,
      })
      if (!eligibility.eligible) continue

      assertValidTransition(shipment.id, shipment.status as WarehouseShipmentStatus, "LABEL_PURCHASING")
      await fulfillmentService.updateWarehouseShipments([{ id: shipment.id, status: "LABEL_PURCHASING" }])
      await emitEvent(container, shipment.id, "LABEL_PURCHASE_STARTED", { attempt: shipment.label_attempt_count + 1 })

      const packages = await packagePlanningService.listPackages({ package_plan_id: shipment.package_plan_id })
      const warehouse = await supplierService.retrieveSupplierWarehouse(shipment.supplier_warehouse_id)
      const [quote] = await checkoutGuardsService.listShippingQuotes({ id: shipment.shipping_quote_id })

      const request: PurchaseShippingLabelRequest = {
        origin: {
          name: `SAME ${warehouse.external_code}`,
          company: "SAME",
          phone: warehouse.phone ?? "",
          street: warehouse.address ?? "",
          number: "",
          district: warehouse.district ?? "",
          city: warehouse.city ?? "",
          state: warehouse.state ?? "",
          country: warehouse.country ?? "MX",
          postalCode: warehouse.postal_code ?? "",
        },
        destination: {
          name: [address?.first_name, address?.last_name].filter(Boolean).join(" ") || "Cliente",
          phone: address?.phone ?? "",
          street: address?.address_1 ?? "",
          number: address?.address_2 ?? "",
          district: address?.address_2 ?? "",
          city: address?.city ?? "",
          state: address?.province ?? "",
          country: address?.country_code ?? "MX",
          postalCode: address?.postal_code ?? "",
        },
        packages: packages
          .filter((p) => p.status === "planned")
          .map((p) => ({ weightKg: Number(p.weight_kg), lengthCm: Number(p.length_cm), widthCm: Number(p.width_cm), heightCm: Number(p.height_cm), declaredValue: 0 })),
        carrierCode: shipment.carrier_code,
        serviceCode: shipment.service_code,
        providerQuoteReference: quote?.quote_reference ?? null,
        quotedProviderAmount: quote?.provider_amount ? Number(quote.provider_amount) : null,
        currencyCode: quote?.currency_code ?? "mxn",
        // Ancla de idempotencia estable (plan §16) -- NUNCA regenerada entre reintentos.
        idempotencyKey: shipment.id,
      }

      let result
      try {
        result = await provider.purchaseLabel(request)
      } catch (error) {
        // Una excepción CRUDA (no un PurchaseShippingLabelResult tipado)
        // significa que el adapter no pudo clasificar lo que pasó -- se usa
        // LABEL_INVALID_RESPONSE (nunca LABEL_PROVIDER_UNAVAILABLE, que la
        // taxonomía define como "limpio, no ambiguo") porque su perfil en
        // rules/error-taxonomy.ts YA es {retryable:false,
        // sideEffectMayHaveOccurred:true, manualReviewRequired:true} --
        // exactamente el default seguro ante incertidumbre (plan §45/§9:
        // "nunca reintentar ciegamente"). Un adapter real que SÍ sabe que
        // no hubo side effect debe devolver un resultado tipado con su
        // propio errorCode, nunca lanzar, para no caer en esta rama.
        result = {
          status: "ERROR" as const,
          errorCode: "LABEL_INVALID_RESPONSE" as const,
          errorMessage: error instanceof Error ? error.message : "Error desconocido",
          sideEffectMayHaveOccurred: resolveFulfillmentErrorProfile("LABEL_INVALID_RESPONSE").sideEffectMayHaveOccurred,
        }
      }

      if (result.status === "ERROR") {
        const nextAttemptCount = shipment.label_attempt_count + 1
        // Ambigüedad real (plan §45): nunca se reintenta automáticamente.
        if (result.sideEffectMayHaveOccurred) {
          assertValidTransition(shipment.id, "LABEL_PURCHASING", "REQUIRES_MANUAL_REVIEW")
          await fulfillmentService.updateWarehouseShipments([
            {
              id: shipment.id,
              status: "REQUIRES_MANUAL_REVIEW",
              requires_manual_review: true,
              manual_review_reason: `AMBIGUOUS_LABEL_PURCHASE: ${result.errorCode}`,
              label_attempt_count: nextAttemptCount,
              label_last_error_code: result.errorCode,
              label_last_error_message: result.errorMessage,
              label_last_attempt_at: now,
            },
          ])
          await emitEvent(container, shipment.id, "WAREHOUSE_SHIPMENT_MANUAL_REVIEW", {
            reason: "AMBIGUOUS_LABEL_PURCHASE",
            errorCode: result.errorCode,
          })
          continue
        }

        // `PurchaseShippingLabelResult` (a diferencia de `SupplierOrderResult`)
        // nunca trae su propio `retryable` -- la ÚNICA fuente de esa
        // decisión es la taxonomía central (plan §38: "error taxonomy
        // integrada... retryable/sideEffectMayHaveOccurred/
        // requiresManualReview coherentes"), nunca "reintentar hasta
        // agotar intentos sin importar qué código fue".
        const errorProfile = resolveFulfillmentErrorProfile(result.errorCode)
        const stillEligible = errorProfile.retryable && nextAttemptCount < retryPolicy.maxAttempts
        const nextStatus: WarehouseShipmentStatus = stillEligible ? "LABEL_FAILED_RETRYABLE" : "LABEL_FAILED_FINAL"
        assertValidTransition(shipment.id, "LABEL_PURCHASING", nextStatus)
        await fulfillmentService.updateWarehouseShipments([
          {
            id: shipment.id,
            status: nextStatus,
            label_attempt_count: nextAttemptCount,
            label_last_error_code: result.errorCode,
            label_last_error_message: result.errorMessage,
            label_last_attempt_at: now,
            ...(nextStatus === "LABEL_FAILED_FINAL"
              ? { requires_manual_review: true, manual_review_reason: `LABEL_FAILED_FINAL: ${result.errorCode}` }
              : {}),
          },
        ])
        await emitEvent(container, shipment.id, "LABEL_PURCHASE_FAILED", { errorCode: result.errorCode, attempt: nextAttemptCount })
        if (nextStatus === "LABEL_FAILED_FINAL") {
          await emitEvent(container, shipment.id, "WAREHOUSE_SHIPMENT_MANUAL_REVIEW", { reason: "LABEL_FAILED_FINAL" })
        }
        continue
      }

      // PURCHASED -- persistir el side effect INMEDIATAMENTE (plan §48),
      // antes de cualquier otra operación. El PDF base64 se sube a
      // storage nativo de Medusa (Modules.FILE) y solo se guarda la
      // referencia (plan §18) -- nunca el base64 en la fila/logs.
      const file = await fileService.createFiles({
        filename: `label-${shipment.id}.${result.labelFormat === "ZPL" ? "zpl" : "pdf"}`,
        mimeType: result.labelFormat === "ZPL" ? "application/octet-stream" : "application/pdf",
        content: result.labelBase64,
      })

      const variance = evaluateProviderCostVariance(
        request.quotedProviderAmount,
        result.providerCostAmount,
        DEFAULT_PROVIDER_COST_VARIANCE_POLICY
      )

      assertValidTransition(
        shipment.id,
        "LABEL_PURCHASING",
        variance === "ACCEPT" ? "LABEL_PURCHASED" : "REQUIRES_MANUAL_REVIEW"
      )
      await fulfillmentService.updateWarehouseShipments([
        {
          id: shipment.id,
          status: variance === "ACCEPT" ? "LABEL_PURCHASED" : "REQUIRES_MANUAL_REVIEW",
          tracking_number: result.trackingNumber,
          label_reference: file.url,
          label_format: result.labelFormat,
          provider_shipment_id: result.providerShipmentId,
          provider_cost_amount: result.providerCostAmount,
          label_attempt_count: shipment.label_attempt_count + 1,
          label_last_attempt_at: now,
          label_last_error_code: null,
          label_last_error_message: null,
          ...(variance !== "ACCEPT"
            ? { requires_manual_review: true, manual_review_reason: `PROVIDER_COST_VARIANCE_${variance}` }
            : {}),
        },
      ])

      await emitEvent(container, shipment.id, "LABEL_PURCHASED", {
        trackingNumber: result.trackingNumber,
        providerShipmentId: result.providerShipmentId,
        providerCostAmount: result.providerCostAmount,
        costVarianceVerdict: variance,
      })
      if (variance !== "ACCEPT") {
        await emitEvent(container, shipment.id, "WAREHOUSE_SHIPMENT_MANUAL_REVIEW", { reason: `PROVIDER_COST_VARIANCE_${variance}` })
      }
    }

    return new StepResponse(ctx, null)
  }
)

/**
 * Step 3 (plan §20/§21) -- abre el barrier SOLO cuando todos los
 * orígenes relevantes ya tienen guía. Idempotente: si ya se abrió
 * antes, no vuelve a transicionar ni a emitir el evento dos veces.
 */
const checkAllLabelsReadyStep = createStep(
  "check-all-labels-ready",
  async (ctx: { orderId: string; shipments: Array<{ id: string }> }, { container }) => {
    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const current = await fulfillmentService.listWarehouseShipments({ order_id: ctx.orderId })
    const statuses = current.map((s) => s.status as WarehouseShipmentStatus)

    if (!allLabelsReady(statuses)) {
      return new StepResponse(ctx, null)
    }

    const toOpen = current.filter((s) => s.status === "LABEL_PURCHASED")
    if (toOpen.length > 0) {
      toOpen.forEach((s) => assertValidTransition(s.id, "LABEL_PURCHASED", "SUPPLIER_SUBMISSION_PENDING"))
      await fulfillmentService.updateWarehouseShipments(
        toOpen.map((s) => ({ id: s.id, status: "SUPPLIER_SUBMISSION_PENDING" as const }))
      )
      for (const s of toOpen) {
        await emitEvent(container, s.id, "ALL_LABELS_READY", { orderId: ctx.orderId })
      }
    }

    return new StepResponse(ctx, null)
  }
)

/**
 * Step 4 (plan §22-§28) -- UN `SupplierOrderRequest` por
 * WarehouseShipment, usando EXACTAMENTE la guía ya comprada (plan
 * §19/§23) y el adapter real resuelto vía el registro de Etapa 7
 * (`SupplierAdapterRegistry`, reutilizado -- nunca duplicado).
 */
const submitPendingSupplierOrdersStep = createStep(
  "submit-pending-supplier-orders",
  async (ctx: { orderId: string; shipments: Array<{ id: string }> }, { container }) => {
    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const packagePlanningService = container.resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)
    const orderService = container.resolve(Modules.ORDER)
    const registry = resolveSupplierAdapterRegistry(container)

    const order = await orderService.retrieveOrder(ctx.orderId, { relations: ["shipping_address"] })
    const address = order.shipping_address as any
    const now = new Date()

    const eligibleStatuses: WarehouseShipmentStatus[] = ["SUPPLIER_SUBMISSION_PENDING", "SUPPLIER_FAILED_RETRYABLE"]
    const all = await fulfillmentService.listWarehouseShipments({ order_id: ctx.orderId })

    for (const shipment of all) {
      if (!eligibleStatuses.includes(shipment.status as WarehouseShipmentStatus)) continue

      const supplier = await supplierService.retrieveSupplier(shipment.supplier_id)
      let retryPolicy
      try {
        const adapter = registry.resolve(supplier.adapter_key)
        retryPolicy = adapter.order.getRetryPolicy()
      } catch {
        retryPolicy = { maxAttempts: 3, backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000], nonRetryableErrorCodes: [] }
      }

      const eligibility = evaluateRetryEligibility({
        attemptCount: shipment.supplier_attempt_count,
        lastAttemptAt: shipment.supplier_last_attempt_at,
        lastErrorCode: shipment.supplier_last_error_code,
        retryPolicy,
        now,
      })
      if (!eligibility.eligible) continue

      assertValidTransition(shipment.id, shipment.status as WarehouseShipmentStatus, "SUPPLIER_SUBMITTING")
      await fulfillmentService.updateWarehouseShipments([{ id: shipment.id, status: "SUPPLIER_SUBMITTING" }])
      await emitEvent(container, shipment.id, "SUPPLIER_ORDER_SUBMISSION_STARTED", {
        attempt: shipment.supplier_attempt_count + 1,
      })

      const warehouse = await supplierService.retrieveSupplierWarehouse(shipment.supplier_warehouse_id)
      const mappings = await supplierService.listSupplierProductMappings({ supplier_id: shipment.supplier_id })
      const mappingByVariantId = new Map(mappings.map((m) => [m.variant_id, m]))

      const packages = await packagePlanningService.listPackages({ package_plan_id: shipment.package_plan_id })
      const allItems = packages.length
        ? await packagePlanningService.listPackageItems({ package_id: packages.map((p) => p.id) })
        : []
      const linesByVariant = new Map<string, number>()
      for (const item of allItems) {
        linesByVariant.set(item.variant_id, (linesByVariant.get(item.variant_id) ?? 0) + item.quantity)
      }

      const request: SupplierOrderRequest = {
        supplierId: shipment.supplier_id,
        supplierWarehouseId: shipment.supplier_warehouse_id,
        sameOrderId: ctx.orderId,
        warehouseShipmentId: shipment.id,
        referenceId: `SAME-${ctx.orderId}-${warehouse.external_code}`,
        lines: [...linesByVariant.entries()].map(([variantId, quantity]) => ({
          supplierSku: mappingByVariantId.get(variantId)?.supplier_sku ?? variantId,
          quantity,
        })),
        destination: {
          contactName: [address?.first_name, address?.last_name].filter(Boolean).join(" ") || "Cliente",
          email: order.email ?? undefined,
          phone: address?.phone ?? undefined,
          street: address?.address_1 ?? "",
          exteriorNumber: address?.address_2 ?? "",
          neighborhood: address?.address_2 ?? "",
          postalCode: address?.postal_code ?? "",
          city: address?.city ?? undefined,
          state: address?.province ?? undefined,
          country: address?.country_code ?? "MX",
        },
        shipping: shipment.tracking_number
          ? {
              trackingNumber: shipment.tracking_number,
              carrierName: shipment.carrier_code,
              labelFormat: (shipment.label_format as "PDF" | "ZPL" | null) ?? "PDF",
            }
          : undefined,
        externalReferences: { warehouseExternalCode: warehouse.external_code },
      }

      let result
      try {
        const adapter = registry.resolve(supplier.adapter_key)
        result = await adapter.order.submitFulfillmentOrder(request)
      } catch (error) {
        // Excepción cruda (no un SupplierOrderResult tipado) -- igual que
        // en label purchase, el default seguro ante incertidumbre es
        // asumir que el proveedor PUDO haber recibido el pedido (Exel no
        // tiene idempotency key nativa, plan §10: "crítico porque Exel no
        // tiene idempotency key nativa").
        result = {
          success: false,
          error: error instanceof Error ? error.message : "Error desconocido",
          retryable: false,
          sideEffectMayHaveOccurred: true,
        }
      }

      if (!result.success) {
        const nextAttemptCount = shipment.supplier_attempt_count + 1

        // Ambigüedad real (plan §10): nunca se reintenta automáticamente
        // -- mismo tratamiento que label purchase (plan §45).
        if (result.sideEffectMayHaveOccurred) {
          assertValidTransition(shipment.id, "SUPPLIER_SUBMITTING", "REQUIRES_MANUAL_REVIEW")
          await fulfillmentService.updateWarehouseShipments([
            {
              id: shipment.id,
              status: "REQUIRES_MANUAL_REVIEW",
              requires_manual_review: true,
              manual_review_reason: `AMBIGUOUS_SUPPLIER_SUBMISSION: ${result.error}`,
              supplier_attempt_count: nextAttemptCount,
              supplier_last_error_code: "SUPPLIER_SUBMISSION_AMBIGUOUS",
              supplier_last_error_message: result.error,
              supplier_last_attempt_at: now,
            },
          ])
          await emitEvent(container, shipment.id, "WAREHOUSE_SHIPMENT_MANUAL_REVIEW", {
            reason: "AMBIGUOUS_SUPPLIER_SUBMISSION",
            error: result.error,
          })
          continue
        }

        // `result.retryable` viene del propio adapter (plan §27: el adapter
        // es quien sabe si SU error es de negocio/permanente o transitorio)
        // -- `false` explícito corta el reintento aunque queden intentos.
        const stillEligible = result.retryable !== false && nextAttemptCount < retryPolicy.maxAttempts
        const nextStatus: WarehouseShipmentStatus = stillEligible ? "SUPPLIER_FAILED_RETRYABLE" : "SUPPLIER_FAILED_FINAL"

        assertValidTransition(shipment.id, "SUPPLIER_SUBMITTING", nextStatus)
        await fulfillmentService.updateWarehouseShipments([
          {
            id: shipment.id,
            status: nextStatus,
            supplier_attempt_count: nextAttemptCount,
            supplier_last_error_code: result.retryable === false ? "SUPPLIER_VALIDATION_ERROR" : "SUPPLIER_UNAVAILABLE",
            supplier_last_error_message: result.error,
            supplier_last_attempt_at: now,
            ...(nextStatus === "SUPPLIER_FAILED_FINAL"
              ? { requires_manual_review: true, manual_review_reason: `SUPPLIER_FAILED_FINAL: ${result.error}` }
              : {}),
          },
        ])
        await emitEvent(container, shipment.id, "SUPPLIER_ORDER_FAILED", { error: result.error, attempt: nextAttemptCount })
        if (nextStatus === "SUPPLIER_FAILED_FINAL") {
          await emitEvent(container, shipment.id, "WAREHOUSE_SHIPMENT_MANUAL_REVIEW", { reason: "SUPPLIER_FAILED_FINAL" })
        }
        continue
      }

      assertValidTransition(shipment.id, "SUPPLIER_SUBMITTING", "SUPPLIER_ACCEPTED")
      await fulfillmentService.updateWarehouseShipments([
        {
          id: shipment.id,
          status: "SUPPLIER_ACCEPTED",
          supplier_order_reference: result.supplierOrderId ?? null,
          supplier_order_status: result.rawStatus ?? null,
          supplier_attempt_count: shipment.supplier_attempt_count + 1,
          supplier_last_attempt_at: now,
          supplier_last_error_code: null,
          supplier_last_error_message: null,
        },
      ])
      await emitEvent(container, shipment.id, "SUPPLIER_ORDER_ACCEPTED", { supplierOrderReference: result.supplierOrderId })
    }

    return new StepResponse(ctx, null)
  }
)

export const processOrderFulfillmentWorkflow = createWorkflow(
  "process-order-fulfillment",
  (input: ProcessOrderFulfillmentInput) => {
    const ensured = ensureWarehouseShipmentsStep(input)
    const afterLabels = purchaseMissingLabelsStep(ensured)
    const afterBarrier = checkAllLabelsReadyStep(afterLabels)
    const afterSubmission = submitPendingSupplierOrdersStep(afterBarrier)

    return new WorkflowResponse(afterSubmission)
  }
)

/**
 * Lectura final del estado agregado -- SIEMPRE derivada, nunca
 * persistida aparte (plan §36). Se expone como función independiente
 * (no como step) porque es puramente de lectura y los callers (tests,
 * futuros endpoints admin) la necesitan sin tener que re-correr el
 * workflow completo.
 */
export async function getOrderFulfillmentSummary(
  container: { resolve: <T = unknown>(key: string) => T },
  orderId: string
): Promise<ProcessOrderFulfillmentResult> {
  const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
  const shipments = await fulfillmentService.listWarehouseShipments({ order_id: orderId })
  return {
    orderId,
    orderFulfillmentStatus: deriveOrderFulfillmentStatus(shipments.map((s) => s.status as WarehouseShipmentStatus)),
    shipments: shipments.map((s) => ({
      id: s.id,
      supplierId: s.supplier_id,
      supplierWarehouseId: s.supplier_warehouse_id,
      status: s.status as WarehouseShipmentStatus,
    })),
  }
}

