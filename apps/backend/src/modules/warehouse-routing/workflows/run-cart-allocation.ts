import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../../supplier"
import type SupplierModuleService from "../../supplier/service"
import { WAREHOUSE_ROUTING_MODULE } from "../index"
import type WarehouseRoutingModuleService from "../service"
import {
  allocateCart,
  type AllocateCartResult,
  type AllocationLineResult,
  type AllocationShortage,
  type RoutingCandidate,
} from "../rules/allocate-cart"
import { evaluateRoutingCandidateEligibility } from "../rules/candidate-eligibility"
import { resolveConfiguredPriority, type RoutingRuleEntry } from "../rules/routing-rule-matching"
import { haversineDistanceKm, type GeoPoint } from "../rules/distance"
import { computeAllocationFingerprint } from "../rules/fingerprint"
import { resolveCommerceAuditEmitter } from "../../commerce-audit/events"

/**
 * I/O del algoritmo puro `allocateCart()` — construye los
 * `RoutingCandidate` reales (Supplier/SupplierWarehouse/InventoryLevel/
 * RoutingRule vía Medusa nativo + módulo `supplier`), corre el
 * algoritmo, y persiste la decisión como `AllocationSnapshot` (con
 * `AllocationLine`/`AllocationAssignment`). Mismo patrón de separación
 * que `apply-reconciled-inventory.ts` (Etapa 4) y
 * `apply-supplier-pricing.ts` (Etapa 5/5.1): toda regla de negocio real
 * vive en `rules/`, aquí solo I/O y orquestación.
 *
 * Idempotencia (plan Etapa 6): si ya existe una AllocationSnapshot
 * ACTIVE para este carrito con el MISMO fingerprint (mismas líneas,
 * mismo destino) y todavía no expiró, se reutiliza — nunca se
 * recalculan ni se duplican snapshots para una intención de carrito sin
 * cambios reales.
 *
 * NO implementa (deliberadamente, pedido explícito del usuario):
 * `confirmAllocationLive()`, `ReservationItem`, checkout, cotización de
 * envío, selección de carrier, `WarehouseShipment` real, SAP, migración
 * de WooCommerce, ni cambios al VPS — esto es Etapa 7+.
 */

const ALLOCATION_SNAPSHOT_TTL_MS = 30 * 60 * 1000
const MAX_INVENTORY_AGE_MS = 24 * 60 * 60 * 1000
const ROUTING_POLICY_VERSION = "default-v1"

export interface RunCartAllocationInput {
  cartId: string
  lines: Array<{ variantId: string; quantity: number }>
  destination: {
    state: string | null
    latitude: number | null
    longitude: number | null
  }
  singleOriginEnabled: boolean
  preferredWarehouseCode: string | null
}

/**
 * Candidatos reales para UNA variant: recorre InventoryLevel (vía el
 * InventoryItem linkeado a la Variant), resuelve el SupplierWarehouse
 * dueño de cada StockLocation (link Etapa 2/4), y solo incluye el nivel
 * si ADEMÁS existe un SupplierProductMapping activo y no quarantined
 * entre ESE proveedor y esta variant (un supplier cuyo almacén tiene
 * stock cacheado para este InventoryItem pero que ya no vende este
 * producto no es un origen válido). Elegibilidad completa vía
 * `evaluateRoutingCandidateEligibility` — nunca inline aquí.
 */
async function resolveCandidatesForVariant(
  variantId: string,
  deps: {
    container: { resolve: (key: string | symbol) => any }
    supplierService: SupplierModuleService
    destinationState: string | null
    destinationCoords: GeoPoint | null
    routingRules: RoutingRuleEntry[]
    now: Date
  }
): Promise<RoutingCandidate[]> {
  const { container, supplierService, destinationState, destinationCoords, routingRules, now } = deps
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const inventoryService = container.resolve(Modules.INVENTORY)

  const itemLinks = await link.list(
    {
      [Modules.PRODUCT]: { variant_id: variantId },
      [Modules.INVENTORY]: { inventory_item_id: { $ne: null } },
    },
    {}
  )
  if (itemLinks.length === 0) return []
  const inventoryItemId = (itemLinks[0] as { inventory_item_id: string }).inventory_item_id

  const levels = await inventoryService.listInventoryLevels({ inventory_item_id: inventoryItemId })
  if (levels.length === 0) return []

  const locationIds = levels.map((level: { location_id: string }) => level.location_id)
  // Orden de las llaves NO intercambiable: el link se registró como
  // defineLink(SupplierModule.linkable.supplierWarehouse,
  // StockLocationModule.linkable.stockLocation) -- Link.getLinkModule()
  // busca por ["primary"-serviceName, ...,"foreign"-serviceName, ...]
  // en ESE orden exacto (ver node_modules/@medusajs/modules-sdk/dist/
  // link.js, relationsPairs se llena una sola vez con ese orden) --
  // pasar [Modules.STOCK_LOCATION] primero revienta con "Module ... was
  // not found" aunque los nombres de campo sean correctos (bug real
  // detectado por los tests de integración de esta etapa).
  const warehouseLinks = await link.list(
    {
      [SUPPLIER_MODULE]: { supplier_warehouse_id: { $ne: null } },
      [Modules.STOCK_LOCATION]: { stock_location_id: locationIds },
    },
    {}
  )
  const warehouseIdByLocationId = new Map<string, string>(
    warehouseLinks.map((l: { stock_location_id: string; supplier_warehouse_id: string }) => [
      l.stock_location_id,
      l.supplier_warehouse_id,
    ])
  )
  const warehouseIds = [...new Set(warehouseIdByLocationId.values())]
  if (warehouseIds.length === 0) return []

  const warehouses = await supplierService.listSupplierWarehouses({ id: warehouseIds })
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]))
  const supplierIds = [...new Set(warehouses.map((w) => w.supplier_id as string))]
  const suppliers = await supplierService.listSuppliers({ id: supplierIds })
  const supplierById = new Map(suppliers.map((s) => [s.id, s]))

  const mappings = await supplierService.listSupplierProductMappings({
    variant_id: variantId,
    supplier_id: supplierIds,
  })
  const mappingBySupplierId = new Map(mappings.map((m) => [m.supplier_id, m]))
  const states = await supplierService.listSupplierProductStates({
    supplier_product_mapping_id: mappings.map((m) => m.id),
  })
  const stateByMappingId = new Map(states.map((s) => [s.supplier_product_mapping_id, s]))

  const candidates: RoutingCandidate[] = []
  for (const level of levels as Array<{
    location_id: string
    available_quantity: number
  }>) {
    const warehouseId = warehouseIdByLocationId.get(level.location_id)
    const warehouse = warehouseId ? warehouseById.get(warehouseId) : undefined
    if (!warehouse) continue
    const supplier = supplierById.get(warehouse.supplier_id as string)
    if (!supplier) continue
    const mapping = mappingBySupplierId.get(supplier.id)
    if (!mapping) continue
    const state = stateByMappingId.get(mapping.id)

    const eligibility = evaluateRoutingCandidateEligibility(
      {
        supplierStatus: supplier.status as "active" | "inactive",
        warehouseStatus: warehouse.status as "active" | "inactive",
        mappingStatus: mapping.status as "active" | "inactive",
        supplierProductStateStatus: (state?.status as "active" | "quarantined" | undefined) ?? null,
        inventoryConfirmedAt: state?.last_apply_at ?? null,
      },
      { maxInventoryAgeMs: MAX_INVENTORY_AGE_MS, now }
    )
    if (!eligibility.eligible) continue

    const configuredPriority = resolveConfiguredPriority(destinationState, routingRules, {
      supplierId: supplier.id,
      supplierWarehouseId: warehouse.id,
    })
    const distanceKm =
      destinationCoords && warehouse.latitude != null && warehouse.longitude != null
        ? haversineDistanceKm(destinationCoords, {
            latitude: warehouse.latitude as number,
            longitude: warehouse.longitude as number,
          })
        : null

    candidates.push({
      supplierId: supplier.id,
      supplierWarehouseId: warehouse.id,
      warehouseCode: warehouse.external_code as string,
      stockLocationId: level.location_id,
      availableQuantity: Number(level.available_quantity),
      configuredPriority,
      distanceKm,
    })
  }
  return candidates
}

interface ResolvedAllocationContext {
  reuse: boolean
  existingSnapshotId?: string
  fingerprint: string
  algorithmResult?: AllocateCartResult
  cartId: string
  destination: RunCartAllocationInput["destination"]
}

const resolveAndAllocateCartStep = createStep(
  "resolve-and-allocate-cart",
  async (
    input: RunCartAllocationInput,
    { container }
  ): Promise<StepResponse<ResolvedAllocationContext, null>> => {
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)
    const now = new Date()

    const fingerprint = computeAllocationFingerprint({
      lines: input.lines,
      destinationState: input.destination.state,
    })

    const [existingActive] = await routingService.listAllocationSnapshots({
      cart_id: input.cartId,
      status: "active",
    })
    if (
      existingActive &&
      existingActive.input_fingerprint === fingerprint &&
      (!existingActive.expires_at || existingActive.expires_at > now)
    ) {
      return new StepResponse(
        {
          reuse: true,
          existingSnapshotId: existingActive.id,
          fingerprint,
          cartId: input.cartId,
          destination: input.destination,
        },
        null
      )
    }

    const destinationCoords: GeoPoint | null =
      input.destination.latitude != null && input.destination.longitude != null
        ? { latitude: input.destination.latitude, longitude: input.destination.longitude }
        : null
    const normalizedDestinationState = input.destination.state?.trim().toUpperCase() || null

    const rawRules = normalizedDestinationState
      ? await routingService.listRoutingRules({
          destination_state: normalizedDestinationState,
          status: "active",
        })
      : []
    const routingRules: RoutingRuleEntry[] = rawRules.map((r) => ({
      destinationState: r.destination_state,
      supplierId: r.supplier_id,
      supplierWarehouseId: r.supplier_warehouse_id,
      priority: r.priority,
      status: r.status as "active" | "inactive",
    }))

    const candidatesByVariantId: Record<string, RoutingCandidate[]> = {}
    for (const line of input.lines) {
      candidatesByVariantId[line.variantId] = await resolveCandidatesForVariant(line.variantId, {
        container,
        supplierService,
        destinationState: normalizedDestinationState,
        destinationCoords,
        routingRules,
        now,
      })
    }

    const algorithmResult = allocateCart({
      lines: input.lines,
      candidatesByVariantId,
      preferredWarehouseCode: input.preferredWarehouseCode,
      singleOriginEnabled: input.singleOriginEnabled,
    })

    return new StepResponse(
      { reuse: false, fingerprint, algorithmResult, cartId: input.cartId, destination: input.destination },
      null
    )
  }
)

export interface PersistedAllocationResult {
  snapshotId: string | null
  status: AllocateCartResult["status"]
  strategy?: "single_origin" | "multi_origin"
  lines?: AllocationLineResult[]
  shortages?: AllocationShortage[]
}

interface CreatedSnapshotResources {
  snapshotId: string
  supersededSnapshotId: string | null
}

async function formatPersistedSnapshot(
  routingService: WarehouseRoutingModuleService,
  snapshotId: string
): Promise<PersistedAllocationResult> {
  const snapshot = await routingService.retrieveAllocationSnapshot(snapshotId)
  const lines = await routingService.listAllocationLines({ allocation_snapshot_id: snapshotId })
  const lineIds = lines.map((l) => l.id)
  const assignments = lineIds.length
    ? await routingService.listAllocationAssignments({ allocation_line_id: lineIds })
    : []
  const assignmentsByLineId = new Map<string, typeof assignments>()
  for (const assignment of assignments) {
    const existing = assignmentsByLineId.get(assignment.allocation_line_id) ?? []
    existing.push(assignment)
    assignmentsByLineId.set(assignment.allocation_line_id, existing)
  }

  return {
    snapshotId: snapshot.id,
    status: "FULFILLABLE",
    strategy: snapshot.strategy as "single_origin" | "multi_origin",
    lines: lines.map((line) => ({
      variantId: line.variant_id,
      requestedQuantity: line.requested_quantity,
      assignments: (assignmentsByLineId.get(line.id) ?? []).map((assignment) => ({
        supplierId: assignment.supplier_id,
        supplierWarehouseId: assignment.supplier_warehouse_id,
        stockLocationId: assignment.stock_location_id,
        quantity: assignment.quantity,
      })),
    })),
  }
}

const persistAllocationSnapshotStep = createStep(
  "persist-allocation-snapshot",
  async (
    ctx: ResolvedAllocationContext,
    { container }
  ): Promise<StepResponse<PersistedAllocationResult, CreatedSnapshotResources | null>> => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)

    if (ctx.reuse) {
      const formatted = await formatPersistedSnapshot(routingService, ctx.existingSnapshotId!)
      return new StepResponse(formatted, null)
    }

    auditEmitter.emit({
      eventType: "ROUTING_STARTED",
      correlationId: ctx.cartId,
      details: { cartId: ctx.cartId },
      occurredAt: new Date(),
    })

    const result = ctx.algorithmResult!

    if (result.status === "UNFULFILLABLE") {
      auditEmitter.emit({
        eventType: "ROUTING_UNFULFILLABLE",
        correlationId: ctx.cartId,
        details: { shortages: result.shortages },
        occurredAt: new Date(),
      })
      return new StepResponse(
        { snapshotId: null, status: "UNFULFILLABLE", shortages: result.shortages },
        null
      )
    }

    const [previousActive] = await routingService.listAllocationSnapshots({
      cart_id: ctx.cartId,
      status: "active",
    })
    if (previousActive) {
      await routingService.updateAllocationSnapshots([{ id: previousActive.id, status: "superseded" }])
    }

    const snapshot = await routingService.createAllocationSnapshots({
      cart_id: ctx.cartId,
      status: "active",
      strategy: result.strategy === "SINGLE_ORIGIN" ? "single_origin" : "multi_origin",
      destination: ctx.destination,
      input_fingerprint: ctx.fingerprint,
      routing_policy_version: ROUTING_POLICY_VERSION,
      expires_at: new Date(Date.now() + ALLOCATION_SNAPSHOT_TTL_MS),
    })

    for (const line of result.lines) {
      const createdLine = await routingService.createAllocationLines({
        allocation_snapshot_id: snapshot.id,
        variant_id: line.variantId,
        requested_quantity: line.requestedQuantity,
      })
      for (const assignment of line.assignments) {
        await routingService.createAllocationAssignments({
          allocation_line_id: createdLine.id,
          supplier_id: assignment.supplierId,
          supplier_warehouse_id: assignment.supplierWarehouseId,
          stock_location_id: assignment.stockLocationId,
          quantity: assignment.quantity,
        })
      }
    }

    auditEmitter.emit({
      eventType: "ALLOCATION_CREATED",
      correlationId: ctx.cartId,
      details: { snapshotId: snapshot.id, strategy: result.strategy },
      occurredAt: new Date(),
    })
    if (previousActive) {
      auditEmitter.emit({
        eventType: "ALLOCATION_SUPERSEDED",
        correlationId: ctx.cartId,
        details: { supersededSnapshotId: previousActive.id, newSnapshotId: snapshot.id },
        occurredAt: new Date(),
      })
    }
    auditEmitter.emit({
      eventType: "ROUTING_COMPLETED",
      correlationId: ctx.cartId,
      details: { snapshotId: snapshot.id, strategy: result.strategy },
      occurredAt: new Date(),
    })

    return new StepResponse(
      {
        snapshotId: snapshot.id,
        status: "FULFILLABLE",
        strategy: snapshot.strategy as "single_origin" | "multi_origin",
        lines: result.lines,
      },
      { snapshotId: snapshot.id, supersededSnapshotId: previousActive?.id ?? null }
    )
  },
  async (created, { container }) => {
    if (!created) return
    const routingService = container.resolve<WarehouseRoutingModuleService>(WAREHOUSE_ROUTING_MODULE)

    const lines = await routingService.listAllocationLines({ allocation_snapshot_id: created.snapshotId })
    const lineIds = lines.map((l) => l.id)
    if (lineIds.length) {
      const assignments = await routingService.listAllocationAssignments({ allocation_line_id: lineIds })
      if (assignments.length) {
        await routingService.deleteAllocationAssignments(assignments.map((a) => a.id))
      }
      await routingService.deleteAllocationLines(lineIds)
    }
    await routingService.deleteAllocationSnapshots([created.snapshotId])

    if (created.supersededSnapshotId) {
      await routingService.updateAllocationSnapshots([{ id: created.supersededSnapshotId, status: "active" }])
    }
  }
)

export const runCartAllocationWorkflow = createWorkflow(
  "run-cart-allocation",
  (input: RunCartAllocationInput) => {
    const resolved = resolveAndAllocateCartStep(input)
    const persisted = persistAllocationSnapshotStep(resolved)
    return new WorkflowResponse(persisted)
  }
)
