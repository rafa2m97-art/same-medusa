import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../../supplier"
import type SupplierModuleService from "../../supplier/service"
import { WAREHOUSE_ROUTING_MODULE } from "../../warehouse-routing"
import type WarehouseRoutingModuleService from "../../warehouse-routing/service"
import { CHECKOUT_GUARDS_MODULE } from "../../checkout-guards"
import type CheckoutGuardsModuleService from "../../checkout-guards/service"
import { resolveCommerceAuditEmitter } from "../../commerce-audit/events"
import { PACKAGE_PLANNING_MODULE } from "../index"
import type PackagePlanningModuleService from "../service"
import { planPackages, type PlanPackagesLine } from "../rules/plan-packages"
import { computePackagePlanFingerprint } from "../rules/fingerprint"
import { evaluateCircuitBreaker } from "../../checkout-guards/rules/circuit-breaker"
import { resolveShippingRateProvider } from "../shipping-rate-provider-registry"
import type { ShippingRateAddress, ShippingRateRequest, NormalizedShippingRate } from "../types"

/**
 * Coordinador de Etapa 8 (plan §1/§55). Dos steps, cada uno
 * independiente y explicable (mismo principio de Etapa 7 §2):
 *
 *   1. `buildPackagePlansStep` -- SOLO lectura/empaque local, nunca
 *      llama a Envia. Decide, por origen, si se puede armar un plan
 *      físico (PLANNED) o si hay que bloquear explícitamente
 *      (MISSING_PHYSICAL_DATA/UNSHIPPABLE) -- nunca llega a pedir una
 *      tarifa para un plan que no se pudo armar.
 *   2. `requestRatesAndBuildSelectionsStep` -- SOLO si TODOS los
 *      orígenes se armaron -- cotiza cada PackagePlan con el
 *      `ShippingRateProvider` activo, agrega cheapest/fastest/
 *      recommended por origen, y persiste `ShippingSelection`/
 *      `ShippingQuote`.
 *
 * Nunca compra guía (plan §57): ningún paso de aquí ni el contrato
 * `ShippingRateProvider` conocen esa operación.
 */

const DEFAULT_PACKING_RULE_VERSION = "default-v1"
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 300_000
const SHIPPING_SELECTION_TTL_MS = 30 * 60 * 1000
const ENVIA_INTEGRATION_KEY = "envia"

export interface PlanAndQuoteShippingInput {
  cartId: string
  circuitBreakerCooldownMs?: number
}

interface OriginGroup {
  supplierId: string
  supplierWarehouseId: string
  lines: PlanPackagesLine[]
}

export type PlanAndQuoteShippingFailureReason = "MISSING_PHYSICAL_DATA" | "UNSHIPPABLE" | "PROVIDER_ERROR"

export interface PlanAndQuoteShippingFailure {
  supplierWarehouseId: string
  reason: PlanAndQuoteShippingFailureReason
  details: Record<string, unknown>
}

export interface PlanAndQuoteShippingResult {
  status: "QUOTED" | "INCOMPLETE"
  shippingSelectionIds?: string[]
  selectedShippingSelectionId?: string
  failures?: PlanAndQuoteShippingFailure[]
}

interface PackagePlanContext {
  packagePlanId: string
  supplierId: string
  supplierWarehouseId: string
  packages: Array<{ id: string; weightKg: number; lengthCm: number; widthCm: number; heightCm: number }>
}

interface BuildPlansContext {
  cartId: string
  destination: ShippingRateAddress | null
  currencyCode: string
  allocationSnapshotId: string | null
  plans: PackagePlanContext[]
  failures: PlanAndQuoteShippingFailure[]
}

/**
 * Step 1 -- carga la AllocationSnapshot vigente, agrupa por origen
 * (plan §6: "un package nunca cruza origins"), corre `planPackages()`
 * puro, y persiste con idempotencia por fingerprint (plan §43) --
 * mismo patrón que AllocationSnapshot (Etapa 6).
 */
const buildPackagePlansStep = createStep(
  "build-package-plans",
  async (input: PlanAndQuoteShippingInput, { container }): Promise<StepResponse<BuildPlansContext, null>> => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const cartService = container.resolve(Modules.CART)
    const productService = container.resolve(Modules.PRODUCT)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
    const packagePlanningService = container.resolve<PackagePlanningModuleService>(PACKAGE_PLANNING_MODULE)

    const cart = await cartService.retrieveCart(input.cartId, { relations: ["shipping_address"] })
    const address = cart.shipping_address as any
    const destination: ShippingRateAddress | null = address
      ? {
          name: [address.first_name, address.last_name].filter(Boolean).join(" ") || "Cliente",
          phone: address.phone ?? "",
          street: address.address_1 ?? "",
          number: address.address_2 ?? "",
          district: address.address_2 ?? "",
          city: address.city ?? "",
          state: address.province ?? "",
          country: address.country_code ?? "MX",
          postalCode: address.postal_code ?? "",
        }
      : null

    const [snapshot] = await routingService.listAllocationSnapshots({ cart_id: input.cartId, status: "active" })
    if (!snapshot) {
      return new StepResponse(
        {
          cartId: input.cartId,
          destination,
          currencyCode: cart.currency_code,
          allocationSnapshotId: null,
          plans: [],
          failures: [{ supplierWarehouseId: "", reason: "MISSING_PHYSICAL_DATA", details: { reason: "no_active_allocation_snapshot" } }],
        },
        null
      )
    }

    const lines = await routingService.listAllocationLines({ allocation_snapshot_id: snapshot.id })
    const lineIds = lines.map((l) => l.id)
    const assignments = lineIds.length
      ? await routingService.listAllocationAssignments({ allocation_line_id: lineIds })
      : []
    const lineById = new Map(lines.map((l) => [l.id, l]))

    const variantIds = [...new Set(lines.map((l) => l.variant_id))]
    const variants = variantIds.length ? await productService.listProductVariants({ id: variantIds }) : []
    const variantById = new Map(variants.map((v: any) => [v.id, v]))

    const warehouseIds = [...new Set(assignments.map((a) => a.supplier_warehouse_id))]
    const warehouses = warehouseIds.length ? await supplierService.listSupplierWarehouses({ id: warehouseIds }) : []
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]))

    const groupsByOrigin = new Map<string, OriginGroup>()
    for (const assignment of assignments) {
      const line = lineById.get(assignment.allocation_line_id)!
      const variant = variantById.get(line.variant_id)
      const key = `${assignment.supplier_id}::${assignment.supplier_warehouse_id}`
      const group = groupsByOrigin.get(key) ?? {
        supplierId: assignment.supplier_id,
        supplierWarehouseId: assignment.supplier_warehouse_id,
        lines: [],
      }
      group.lines.push({
        variantId: line.variant_id,
        allocationAssignmentId: assignment.id,
        quantity: assignment.quantity,
        weightKg: variant?.weight ?? null,
        lengthCm: variant?.length ?? null,
        widthCm: variant?.width ?? null,
        heightCm: variant?.height ?? null,
      })
      groupsByOrigin.set(key, group)
    }

    const [defaultLimitRow] = await packagePlanningService.listCarrierLimits({
      carrier_code: "default",
      status: "active",
    })
    if (!defaultLimitRow) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "No hay CarrierLimit 'default' activo -- ejecutar el seed de límites reales antes de planear paquetes."
      )
    }
    const defaultLimits = {
      maxWeightKg: Number(defaultLimitRow.max_weight_kg),
      maxLengthCm: Number(defaultLimitRow.max_length_cm),
      maxWidthCm: Number(defaultLimitRow.max_width_cm),
      maxHeightCm: Number(defaultLimitRow.max_height_cm),
      maxGirthCm: Number(defaultLimitRow.max_girth_cm),
    }

    const plans: PackagePlanContext[] = []
    const failures: PlanAndQuoteShippingFailure[] = []

    for (const group of groupsByOrigin.values()) {
      const warehouse = warehouseById.get(group.supplierWarehouseId)
      const fingerprint = computePackagePlanFingerprint({
        allocationSnapshotId: snapshot.id,
        supplierWarehouseId: group.supplierWarehouseId,
        lines: group.lines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          weightKg: l.weightKg,
          lengthCm: l.lengthCm,
          widthCm: l.widthCm,
          heightCm: l.heightCm,
        })),
        packingRuleVersion: DEFAULT_PACKING_RULE_VERSION,
      })

      const [existingActive] = await packagePlanningService.listPackagePlans({
        allocation_snapshot_id: snapshot.id,
        supplier_warehouse_id: group.supplierWarehouseId,
        status: "active",
      })
      if (existingActive && existingActive.fingerprint === fingerprint) {
        const existingPackages = await packagePlanningService.listPackages({ package_plan_id: existingActive.id })
        plans.push({
          packagePlanId: existingActive.id,
          supplierId: group.supplierId,
          supplierWarehouseId: group.supplierWarehouseId,
          packages: existingPackages
            .filter((p) => p.status === "planned")
            .map((p) => ({
              id: p.id,
              weightKg: Number(p.weight_kg),
              lengthCm: Number(p.length_cm),
              widthCm: Number(p.width_cm),
              heightCm: Number(p.height_cm),
            })),
        })
        continue
      }

      const planResult = planPackages({ lines: group.lines, defaultLimits })

      if (existingActive) {
        await packagePlanningService.updatePackagePlans([{ id: existingActive.id, status: "superseded" }])
        auditEmitter.emit({
          eventType: "PACKAGE_PLAN_SUPERSEDED",
          correlationId: snapshot.id,
          supplierId: group.supplierId,
          details: { packagePlanId: existingActive.id, supplierWarehouseId: group.supplierWarehouseId },
          occurredAt: new Date(),
        })
      }

      if (planResult.status === "MISSING_PHYSICAL_DATA") {
        await packagePlanningService.createPackagePlans({
          allocation_snapshot_id: snapshot.id,
          supplier_id: group.supplierId,
          supplier_warehouse_id: group.supplierWarehouseId,
          status: "missing_data",
          fingerprint,
          packing_rule_version: DEFAULT_PACKING_RULE_VERSION,
          unshippable_reason: `Faltan datos físicos para: ${planResult.missingVariantIds.join(", ")}`,
        })
        failures.push({
          supplierWarehouseId: group.supplierWarehouseId,
          reason: "MISSING_PHYSICAL_DATA",
          details: { missingVariantIds: planResult.missingVariantIds },
        })
        continue
      }

      if (!warehouse || !warehouse.postal_code || !warehouse.city || !warehouse.state) {
        failures.push({
          supplierWarehouseId: group.supplierWarehouseId,
          reason: "PROVIDER_ERROR",
          details: { reason: "incomplete_warehouse_address" },
        })
        continue
      }

      const anyUnshippable = planResult.packages.some((p) => p.status === "unshippable")
      const createdPlan = await packagePlanningService.createPackagePlans({
        allocation_snapshot_id: snapshot.id,
        supplier_id: group.supplierId,
        supplier_warehouse_id: group.supplierWarehouseId,
        status: anyUnshippable ? "unshippable" : "active",
        fingerprint,
        packing_rule_version: DEFAULT_PACKING_RULE_VERSION,
        unshippable_reason: anyUnshippable
          ? planResult.packages.find((p) => p.status === "unshippable")?.unshippableReason ?? null
          : null,
      })
      auditEmitter.emit({
        eventType: "PACKAGE_PLAN_CREATED",
        correlationId: snapshot.id,
        supplierId: group.supplierId,
        details: { packagePlanId: createdPlan.id, supplierWarehouseId: group.supplierWarehouseId, packages: planResult.packages.length },
        occurredAt: new Date(),
      })

      const createdPackages: PackagePlanContext["packages"] = []
      let sequenceNumber = 1
      for (const planned of planResult.packages) {
        const createdPackage = await packagePlanningService.createPackages({
          package_plan_id: createdPlan.id,
          sequence_number: sequenceNumber++,
          weight_kg: planned.parcel.weightKg,
          length_cm: planned.parcel.lengthCm,
          width_cm: planned.parcel.widthCm,
          height_cm: planned.parcel.heightCm,
          status: planned.status,
          unshippable_reason: planned.unshippableReason,
        })
        for (const item of planned.items) {
          await packagePlanningService.createPackageItems({
            package_id: createdPackage.id,
            allocation_assignment_id: item.allocationAssignmentId,
            variant_id: item.variantId,
            quantity: item.quantity,
          })
        }
        if (planned.status === "planned") {
          createdPackages.push({
            id: createdPackage.id,
            weightKg: planned.parcel.weightKg,
            lengthCm: planned.parcel.lengthCm,
            widthCm: planned.parcel.widthCm,
            heightCm: planned.parcel.heightCm,
          })
        }
      }

      if (anyUnshippable) {
        failures.push({
          supplierWarehouseId: group.supplierWarehouseId,
          reason: "UNSHIPPABLE",
          details: { packagePlanId: createdPlan.id },
        })
        continue
      }

      plans.push({
        packagePlanId: createdPlan.id,
        supplierId: group.supplierId,
        supplierWarehouseId: group.supplierWarehouseId,
        packages: createdPackages,
      })
    }

    return new StepResponse(
      {
        cartId: input.cartId,
        destination,
        currencyCode: cart.currency_code,
        allocationSnapshotId: snapshot.id,
        plans,
        failures,
      },
      null
    )
  }
)

function pickCheapest(rates: NormalizedShippingRate[]): NormalizedShippingRate {
  return [...rates].sort((a, b) => a.amount - b.amount)[0]
}

function pickFastest(rates: NormalizedShippingRate[]): NormalizedShippingRate {
  return [...rates].sort((a, b) => {
    const aDays = a.estimatedDeliveryDays ?? 999
    const bDays = b.estimatedDeliveryDays ?? 999
    if (aDays !== bDays) return aDays - bDays
    return a.amount - b.amount
  })[0]
}

/**
 * Step 2 -- cotiza cada PackagePlan exitoso y construye las 3
 * ShippingSelection reales (plan §20, evidencia real: cheapest/
 * fastest/recommended=cheapest). Circuit breaker reutilizado de Etapa
 * 7 (`LiveConfirmationCircuitState`, `integration_key="envia"`) --
 * nunca martillar Envia si ya está caído (plan §41).
 */
const requestRatesAndBuildSelectionsStep = createStep(
  "request-rates-and-build-selections",
  async (ctx: BuildPlansContext, { container }): Promise<StepResponse<PlanAndQuoteShippingResult, null>> => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const checkoutGuardsService = container.resolve<CheckoutGuardsModuleService>(CHECKOUT_GUARDS_MODULE)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)

    if (ctx.failures.length > 0 || ctx.plans.length === 0 || !ctx.destination) {
      return new StepResponse(
        {
          status: "INCOMPLETE",
          failures: ctx.failures.length > 0 ? ctx.failures : [{ supplierWarehouseId: "", reason: "PROVIDER_ERROR", details: { reason: "no_destination_or_plans" } }],
        },
        null
      )
    }

    const now = new Date()
    const [circuitState] = await checkoutGuardsService.listLiveConfirmationCircuitStates({
      integration_key: ENVIA_INTEGRATION_KEY,
    })
    const breaker = evaluateCircuitBreaker(
      { lastFailureAt: circuitState?.opened_at ?? null },
      { cooldownMs: DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS, now }
    )
    if (breaker.open) {
      return new StepResponse(
        {
          status: "INCOMPLETE",
          failures: ctx.plans.map((p) => ({
            supplierWarehouseId: p.supplierWarehouseId,
            reason: "PROVIDER_ERROR" as const,
            details: { reason: "circuit_open" },
          })),
        },
        null
      )
    }

    const provider = resolveShippingRateProvider(container)
    const warehouseIds = [...new Set(ctx.plans.map((p) => p.supplierWarehouseId))]
    const warehouses = await supplierService.listSupplierWarehouses({ id: warehouseIds })
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]))

    const failures: PlanAndQuoteShippingFailure[] = []
    const ratesByPlan = new Map<string, NormalizedShippingRate[]>()
    let anyProviderFailure = false

    for (const plan of ctx.plans) {
      const warehouse = warehouseById.get(plan.supplierWarehouseId)!
      const origin: ShippingRateAddress = {
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
      }

      const request: ShippingRateRequest = {
        origin,
        destination: ctx.destination,
        packages: plan.packages.map((pkg) => ({
          weightKg: pkg.weightKg,
          lengthCm: pkg.lengthCm,
          widthCm: pkg.widthCm,
          heightCm: pkg.heightCm,
          declaredValue: 0,
        })),
        carrierCodes: [],
        currencyCode: ctx.currencyCode,
      }

      auditEmitter.emit({
        eventType: "SHIPPING_QUOTE_REQUESTED",
        correlationId: ctx.allocationSnapshotId ?? ctx.cartId,
        supplierId: plan.supplierId,
        details: { packagePlanId: plan.packagePlanId, packages: plan.packages.length },
        occurredAt: new Date(),
      })

      let result
      try {
        result = await provider.getRates(request)
      } catch (error) {
        result = {
          success: false as const,
          errorCode: "PROVIDER_UNAVAILABLE" as const,
          errorMessage: error instanceof Error ? error.message : "Error desconocido",
        }
      }

      if (!result.success || result.rates.length === 0) {
        anyProviderFailure = true
        failures.push({
          supplierWarehouseId: plan.supplierWarehouseId,
          reason: "PROVIDER_ERROR",
          details: { errorCode: result.success ? "NO_SERVICE_AVAILABLE" : result.errorCode, errorMessage: result.success ? "sin tarifas" : result.errorMessage },
        })
        auditEmitter.emit({
          eventType: "SHIPPING_QUOTE_FAILED",
          correlationId: ctx.allocationSnapshotId ?? ctx.cartId,
          supplierId: plan.supplierId,
          details: { packagePlanId: plan.packagePlanId, errorCode: result.success ? "NO_SERVICE_AVAILABLE" : result.errorCode },
          occurredAt: new Date(),
        })
        continue
      }

      auditEmitter.emit({
        eventType: "SHIPPING_QUOTE_RECEIVED",
        correlationId: ctx.allocationSnapshotId ?? ctx.cartId,
        supplierId: plan.supplierId,
        details: { packagePlanId: plan.packagePlanId, ratesCount: result.rates.length },
        occurredAt: new Date(),
      })
      ratesByPlan.set(plan.packagePlanId, result.rates)
    }

    if (circuitState && !anyProviderFailure) {
      await checkoutGuardsService.deleteLiveConfirmationCircuitStates([circuitState.id])
    } else if (anyProviderFailure) {
      if (circuitState) {
        await checkoutGuardsService.updateLiveConfirmationCircuitStates([{ id: circuitState.id, opened_at: now }])
      } else {
        await checkoutGuardsService.createLiveConfirmationCircuitStates({ integration_key: ENVIA_INTEGRATION_KEY, opened_at: now })
      }
    }

    if (failures.length > 0) {
      return new StepResponse({ status: "INCOMPLETE", failures }, null)
    }

    const previousActiveSelections = await checkoutGuardsService.listShippingSelections({
      cart_id: ctx.cartId,
      status: "active",
    })
    for (const previous of previousActiveSelections) {
      await checkoutGuardsService.updateShippingSelections([{ id: previous.id, status: "superseded" }])
    }

    const labels: Array<{ level: "cheapest" | "fastest" | "recommended"; pick: (rates: NormalizedShippingRate[]) => NormalizedShippingRate }> = [
      { level: "cheapest", pick: pickCheapest },
      { level: "fastest", pick: pickFastest },
      { level: "recommended", pick: pickCheapest },
    ]

    const shippingSelectionIds: string[] = []
    let selectedShippingSelectionId: string | null = null

    for (const label of labels) {
      let totalCustomerAmount = 0

      const perPlanPick = ctx.plans.map((plan) => {
        const rates = ratesByPlan.get(plan.packagePlanId)!
        const chosen = label.pick(rates)
        totalCustomerAmount += chosen.amount
        return { plan, chosen }
      })

      const selection = await checkoutGuardsService.createShippingSelections({
        cart_id: ctx.cartId,
        allocation_snapshot_id: ctx.allocationSnapshotId!,
        service_level: label.level,
        total_customer_amount: totalCustomerAmount,
        total_provider_amount: totalCustomerAmount,
        currency_code: ctx.currencyCode,
        status: label.level === "recommended" ? "selected" : "active",
        expires_at: new Date(Date.now() + SHIPPING_SELECTION_TTL_MS),
      })
      shippingSelectionIds.push(selection.id)
      if (label.level === "recommended") selectedShippingSelectionId = selection.id

      for (const { plan, chosen } of perPlanPick) {
        await checkoutGuardsService.createShippingQuotes({
          cart_id: ctx.cartId,
          allocation_snapshot_id: ctx.allocationSnapshotId!,
          package_plan_id: plan.packagePlanId,
          shipping_selection_id: selection.id,
          carrier_name: chosen.carrierCode,
          carrier_code: chosen.carrierCode,
          service_code: chosen.serviceCode,
          service_level: label.level,
          amount: chosen.amount,
          provider_amount: chosen.amount,
          currency_code: chosen.currencyCode,
          is_free_shipping: false,
          estimated_delivery_days: chosen.estimatedDeliveryDays,
          quote_reference: chosen.providerQuoteReference,
          status: "active",
          expires_at: new Date(Date.now() + SHIPPING_SELECTION_TTL_MS),
        })
      }
    }

    auditEmitter.emit({
      eventType: "SHIPPING_QUOTE_SELECTED",
      correlationId: ctx.allocationSnapshotId ?? ctx.cartId,
      details: { selectedShippingSelectionId },
      occurredAt: new Date(),
    })

    return new StepResponse(
      { status: "QUOTED", shippingSelectionIds, selectedShippingSelectionId: selectedShippingSelectionId! },
      null
    )
  }
)

export const planAndQuoteShippingWorkflow = createWorkflow(
  "plan-and-quote-shipping",
  (input: PlanAndQuoteShippingInput) => {
    const ctx = buildPackagePlansStep(input)
    const result = requestRatesAndBuildSelectionsStep(ctx)
    return new WorkflowResponse(result)
  }
)
