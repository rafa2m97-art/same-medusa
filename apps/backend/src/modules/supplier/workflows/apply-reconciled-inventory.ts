import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { batchInventoryItemLevelsWorkflow } from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../index"
import type SupplierModuleService from "../service"
import {
  planInventoryApply,
  type InventoryApplySkipReason,
} from "../reconciliation/inventory-apply-plan"
import type { ReconciliationResult } from "../reconciliation/reconciliation-result"
import { resolveCommerceAuditEmitter } from "../../commerce-audit/events"

/**
 * Etapa 4 — flujo principal APPLY -> Inventory (plan §4). Única puerta de
 * entrada real para que un ReconciliationResult toque el inventario nativo
 * de Medusa. Nunca vuelve a decidir si los datos del proveedor son
 * confiables (eso ya lo decidió Reconciliation vía `action`) — solo decide
 * CÓMO reflejarlos con seguridad (staleness, mapping/warehouse inactivo,
 * "Last Known Good" durante cuarentena — ver inventory-apply-plan.ts).
 *
 * Atomicidad (plan §12) — trade-off documentado explícitamente: los
 * Workflows de Medusa NO son una transacción ACID única a través de todos
 * los módulos involucrados (Supplier/StockLocation/Inventory son 3 módulos
 * con sus propias conexiones). Lo que SÍ dan, y es lo que se usa aquí, es
 * un saga con compensación: si un paso posterior falla, el engine revierte
 * automáticamente los pasos ya completados (ver compensación de
 * batchInventoryItemLevelsWorkflow — guarda los valores previos de CADA
 * nivel antes de escribir, y los restaura si algo después falla). Además,
 * el estado de ejecución del workflow se persiste en Postgres
 * (WorkflowOrchestratorService) — un crash del proceso Node puede
 * reanudarse/revertirse en el siguiente arranque, no solo durante la
 * ejecución en memoria. No se construyó ninguna transacción manual
 * alrededor de las APIs de Inventory — hubiera sido reinventar algo que
 * el motor de Workflows ya resuelve mejor.
 */

export interface ApplyReconciledInventoryInput {
  result: ReconciliationResult
}

interface ResolvedApplyContext {
  proceed: boolean
  skipReason?: InventoryApplySkipReason
  mappingId: string
  syncRunId: string
  variantId?: string
  inventoryItemId?: string
  toCreate: Array<{ inventory_item_id: string; location_id: string; stocked_quantity: number }>
  toUpdate: Array<{ id: string; inventory_item_id: string; location_id: string; stocked_quantity: number }>
  beforeAfter: Array<{ locationId: string; before: number | null; after: number }>
  syncRunStartedAt?: Date
  createdResources: Array<
    | { kind: "stock_location"; stockLocationId: string; supplierWarehouseId: string }
    | { kind: "inventory_item"; inventoryItemId: string; variantId: string }
  >
}

/**
 * Lee todo lo necesario (mapping, estado, SyncRun, warehouses), aplica
 * `planInventoryApply` (la decisión pura), y si procede, garantiza
 * InventoryItem/StockLocations y calcula el diff create/update contra los
 * InventoryLevel existentes — SIN escribir niveles todavía (eso lo hace el
 * workflow nativo `batchInventoryItemLevelsWorkflow`, componible con su
 * propia compensación real).
 */
const resolveInventoryApplyContextStep = createStep(
  "resolve-inventory-apply-context",
  async (
    input: ApplyReconciledInventoryInput,
    { container }
  ): Promise<StepResponse<ResolvedApplyContext, ResolvedApplyContext["createdResources"]>> => {
    const { result } = input
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)

    auditEmitter.emit({
      eventType: "INVENTORY_APPLY_STARTED",
      correlationId: result.syncRunId,
      supplierProductMappingId: result.supplierProductMappingId,
      syncRunId: result.syncRunId,
      details: { action: result.action },
      occurredAt: new Date(),
    })

    const mapping = await supplierService.retrieveSupplierProductMapping(
      result.supplierProductMappingId
    )
    const [state] = await supplierService.listSupplierProductStates({
      supplier_product_mapping_id: result.supplierProductMappingId,
    })
    const syncRun = await supplierService.retrieveSyncRun(result.syncRunId)

    const base: Pick<ResolvedApplyContext, "mappingId" | "syncRunId" | "createdResources"> = {
      mappingId: mapping.id,
      syncRunId: result.syncRunId,
      createdResources: [],
    }

    if (result.action !== "APPLY") {
      const ctx: ResolvedApplyContext = {
        ...base,
        proceed: false,
        skipReason: "not_apply",
        toCreate: [],
        toUpdate: [],
        beforeAfter: [],
      }
      return new StepResponse(ctx, [])
    }

    const warehouseIds = result.normalizedWarehouseLevels.map((l) => l.supplierWarehouseId)
    const warehouses = await supplierService.listSupplierWarehouses({ id: warehouseIds })
    const warehouseStatusById = new Map(warehouses.map((w) => [w.id, w.status]))

    const plan = planInventoryApply({
      action: result.action,
      mappingStatus: mapping.status,
      supplierProductStateStatus: (state?.status as "active" | "quarantined" | undefined) ?? null,
      incomingSyncRunStartedAt: syncRun.started_at ?? syncRun.created_at,
      lastAppliedSyncRunStartedAt: state?.last_applied_sync_run_started_at ?? null,
      normalizedWarehouseLevels: result.normalizedWarehouseLevels.map((l) => ({
        supplierWarehouseId: l.supplierWarehouseId,
        quantity: l.quantity,
        warehouseStatus: (warehouseStatusById.get(l.supplierWarehouseId) as "active" | "inactive") ?? "inactive",
      })),
    })

    if (!plan.proceed) {
      // Solo el caso realmente STALE es un evento de negocio accionable —
      // "not_apply"/"inactive_mapping"/"still_quarantined"/
      // "no_active_warehouses" son no-ops esperados por diseño, no algo
      // sorprendente que alguien deba revisar.
      if (plan.reason === "stale_sync_run") {
        auditEmitter.emit({
          eventType: "INVENTORY_APPLY_REJECTED_STALE",
          correlationId: result.syncRunId,
          supplierProductMappingId: result.supplierProductMappingId,
          syncRunId: result.syncRunId,
          details: { reason: plan.reason },
          occurredAt: new Date(),
        })
      }
      const ctx: ResolvedApplyContext = {
        ...base,
        proceed: false,
        skipReason: plan.reason,
        toCreate: [],
        toUpdate: [],
        beforeAfter: [],
      }
      return new StepResponse(ctx, [])
    }

    const createdResources: ResolvedApplyContext["createdResources"] = []
    const link = container.resolve(ContainerRegistrationKeys.LINK)

    // --- ensure InventoryItem para la variante ---
    const inventoryService = container.resolve(Modules.INVENTORY)
    const existingItemLinks = await link.list(
      {
        [Modules.PRODUCT]: { variant_id: mapping.variant_id },
        [Modules.INVENTORY]: { inventory_item_id: { $ne: null } },
      },
      {}
    )
    let inventoryItemId: string
    if (existingItemLinks.length > 0) {
      inventoryItemId = (existingItemLinks[0] as { inventory_item_id: string }).inventory_item_id
    } else {
      const [item] = await inventoryService.createInventoryItems([{ sku: mapping.variant_id }])
      await link.create([
        {
          [Modules.PRODUCT]: { variant_id: mapping.variant_id },
          [Modules.INVENTORY]: { inventory_item_id: item.id },
        },
      ])
      inventoryItemId = item.id
      createdResources.push({ kind: "inventory_item", inventoryItemId, variantId: mapping.variant_id })
    }

    // --- ensure StockLocation por cada SupplierWarehouse del plan ---
    const stockLocationService = container.resolve(Modules.STOCK_LOCATION)
    const locationIdByWarehouseId = new Map<string, string>()
    for (const level of plan.levelsToApply) {
      const existingWhLinks = await link.list(
        {
          [SUPPLIER_MODULE]: { supplier_warehouse_id: level.supplierWarehouseId },
          [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } },
        },
        {}
      )
      if (existingWhLinks.length > 0) {
        locationIdByWarehouseId.set(
          level.supplierWarehouseId,
          (existingWhLinks[0] as { stock_location_id: string }).stock_location_id
        )
        continue
      }
      const warehouse = warehouses.find((w) => w.id === level.supplierWarehouseId)
      const [location] = await stockLocationService.createStockLocations([
        { name: warehouse?.name ?? level.supplierWarehouseId },
      ])
      await link.create([
        {
          [SUPPLIER_MODULE]: { supplier_warehouse_id: level.supplierWarehouseId },
          [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
        },
      ])
      locationIdByWarehouseId.set(level.supplierWarehouseId, location.id)
      createdResources.push({
        kind: "stock_location",
        stockLocationId: location.id,
        supplierWarehouseId: level.supplierWarehouseId,
      })
    }

    const locationIds = [...locationIdByWarehouseId.values()]
    const existingLevels = await inventoryService.listInventoryLevels({
      inventory_item_id: inventoryItemId,
      location_id: locationIds,
    })
    const existingByLocation = new Map(existingLevels.map((l) => [l.location_id, l]))

    const toCreate: ResolvedApplyContext["toCreate"] = []
    const toUpdate: ResolvedApplyContext["toUpdate"] = []
    const beforeAfter: ResolvedApplyContext["beforeAfter"] = []

    for (const level of plan.levelsToApply) {
      const locationId = locationIdByWarehouseId.get(level.supplierWarehouseId)!
      const existing = existingByLocation.get(locationId)
      beforeAfter.push({
        locationId,
        before: existing ? Number(existing.stocked_quantity) : null,
        after: level.quantity,
      })
      if (existing) {
        toUpdate.push({
          id: existing.id,
          inventory_item_id: inventoryItemId,
          location_id: locationId,
          stocked_quantity: level.quantity,
        })
      } else {
        toCreate.push({
          inventory_item_id: inventoryItemId,
          location_id: locationId,
          stocked_quantity: level.quantity,
        })
      }
    }

    const ctx: ResolvedApplyContext = {
      ...base,
      proceed: true,
      variantId: mapping.variant_id,
      inventoryItemId,
      toCreate,
      toUpdate,
      beforeAfter,
      syncRunStartedAt: syncRun.started_at ?? syncRun.created_at,
      createdResources,
    }
    return new StepResponse(ctx, createdResources)
  },
  async (createdResources, { container }) => {
    if (!createdResources?.length) {
      return
    }
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    for (const resource of createdResources) {
      if (resource.kind === "stock_location") {
        await link.dismiss([
          {
            [SUPPLIER_MODULE]: { supplier_warehouse_id: resource.supplierWarehouseId },
            [Modules.STOCK_LOCATION]: { stock_location_id: resource.stockLocationId },
          },
        ])
        await container.resolve(Modules.STOCK_LOCATION).deleteStockLocations([resource.stockLocationId])
      } else {
        await link.dismiss([
          {
            [Modules.PRODUCT]: { variant_id: resource.variantId },
            [Modules.INVENTORY]: { inventory_item_id: resource.inventoryItemId },
          },
        ])
        await container.resolve(Modules.INVENTORY).deleteInventoryItems([resource.inventoryItemId])
      }
    }
  }
)

interface MarkAppliedInput {
  ctx: ResolvedApplyContext
}

const markSupplierProductStateAppliedStep = createStep(
  "mark-supplier-product-state-applied",
  async (input: MarkAppliedInput, { container }) => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const { ctx } = input

    if (!ctx.proceed) {
      return new StepResponse(null, null)
    }

    for (const change of ctx.beforeAfter) {
      if (change.before !== change.after) {
        auditEmitter.emit({
          eventType: "INVENTORY_LEVEL_CHANGED",
          correlationId: ctx.syncRunId,
          supplierProductMappingId: ctx.mappingId,
          syncRunId: ctx.syncRunId,
          details: {
            locationId: change.locationId,
            before: change.before,
            after: change.after,
          },
          occurredAt: new Date(),
        })
      }
    }

    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const [existingState] = await supplierService.listSupplierProductStates({
      supplier_product_mapping_id: ctx.mappingId,
    })

    const previous = existingState
      ? {
          last_applied_sync_run_id: existingState.last_applied_sync_run_id,
          last_applied_sync_run_started_at: existingState.last_applied_sync_run_started_at,
          last_apply_at: existingState.last_apply_at,
        }
      : null

    if (existingState) {
      await supplierService.updateSupplierProductStates([
        {
          id: existingState.id,
          last_applied_sync_run_id: ctx.syncRunId,
          last_applied_sync_run_started_at: ctx.syncRunStartedAt,
          last_apply_at: new Date(),
        },
      ])
    } else {
      await supplierService.createSupplierProductStates({
        supplier_product_mapping_id: ctx.mappingId,
        status: "active",
        last_applied_sync_run_id: ctx.syncRunId,
        last_applied_sync_run_started_at: ctx.syncRunStartedAt,
        last_apply_at: new Date(),
      })
    }

    auditEmitter.emit({
      eventType: "INVENTORY_APPLY_COMPLETED",
      correlationId: ctx.syncRunId,
      supplierProductMappingId: ctx.mappingId,
      syncRunId: ctx.syncRunId,
      details: {},
      occurredAt: new Date(),
    })

    return new StepResponse(
      { mappingId: ctx.mappingId, existingStateId: existingState?.id ?? null },
      { mappingId: ctx.mappingId, existingStateId: existingState?.id ?? null, previous }
    )
  },
  async (revert, { container }) => {
    if (!revert?.existingStateId || !revert.previous) {
      return
    }
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    await supplierService.updateSupplierProductStates([
      { id: revert.existingStateId, ...revert.previous },
    ])
  }
)

export const applyReconciledInventoryWorkflow = createWorkflow(
  "apply-reconciled-inventory",
  (input: ApplyReconciledInventoryInput) => {
    const ctx = resolveInventoryApplyContextStep(input)

    const batchInput = transform({ ctx }, (data) => ({
      create: data.ctx.toCreate,
      update: data.ctx.toUpdate,
    }))

    batchInventoryItemLevelsWorkflow.runAsStep({ input: batchInput })

    const markInput = transform({ ctx }, (data) => ({ ctx: data.ctx }))
    const marked = markSupplierProductStateAppliedStep(markInput)

    return new WorkflowResponse(transform({ ctx, marked }, (data) => ({
      proceed: data.ctx.proceed,
      skipReason: data.ctx.skipReason,
      mappingId: data.ctx.mappingId,
      levelsApplied: data.ctx.beforeAfter,
    })))
  }
)
