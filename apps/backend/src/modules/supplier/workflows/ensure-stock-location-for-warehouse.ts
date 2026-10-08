import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../index"

/**
 * Etapa 4, §1-§2 — convierte el Module Link SupplierWarehouse<->StockLocation
 * (declarado en Etapa 2, src/links/supplier-warehouse-stock-location.ts) en
 * algo operativo: dado un SupplierWarehouse, garantiza que exista un
 * StockLocation nativo vinculado, sin duplicar en reintentos.
 *
 * Quién crea el StockLocation / cuándo: este workflow, la primera vez que
 * se invoca para un SupplierWarehouse dado (desde el futuro flujo de
 * provisioning de proveedores — todavía no automatizado en esta etapa).
 * Nombre visible: `"${supplierCode} - ${warehouse.name}"` (ej. "EXEL del
 * Norte - Monterrey") — nunca el código crudo del proveedor (MY/MX/...)
 * como nombre, ese vive solo en SupplierWarehouse.external_code.
 *
 * Cómo se evitan duplicados: el Link mismo es la fuente de verdad de
 * idempotencia — se consulta ANTES de crear (`link.list(...)`), nunca por
 * nombre (StockLocation.name no tiene constraint único real en Medusa).
 *
 * Si el warehouse cambia de nombre: se actualiza el StockLocation
 * EXISTENTE in-place (mismo id) — nunca se crea uno nuevo. El id de
 * StockLocation debe ser estable para siempre porque pedidos/fulfillments
 * reales pueden referenciarlo históricamente.
 *
 * Si el warehouse se desactiva: este workflow deliberadamente NO borra ni
 * modifica el StockLocation — ver supplier-warehouse-lifecycle.md. La
 * exclusión de un warehouse inactivo ocurre en
 * reconciliation/inventory-apply-plan.ts (se deja de escribir), nunca
 * aquí.
 */

export interface EnsureStockLocationForWarehouseInput {
  supplierWarehouseId: string
  /** Nombre visible deseado HOY para el StockLocation (ej. "EXEL del Norte - Monterrey"). */
  desiredName: string
}

export interface EnsureStockLocationForWarehouseOutput {
  stockLocationId: string
  created: boolean
  renamed: boolean
}

type StepCompensation =
  | { kind: "created"; stockLocationId: string; supplierWarehouseId: string }
  | { kind: "renamed"; stockLocationId: string; previousName: string }
  | { kind: "noop" }

export const ensureStockLocationForWarehouseStep = createStep(
  "ensure-stock-location-for-warehouse",
  async (
    input: EnsureStockLocationForWarehouseInput,
    { container }
  ): Promise<StepResponse<EnsureStockLocationForWarehouseOutput, StepCompensation>> => {
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const stockLocationService = container.resolve(Modules.STOCK_LOCATION)

    // link.list() identifica el módulo del OTRO lado por el nombre del
    // campo (Object.keys), no por su valor -- un objeto vacío no basta.
    const existingLinks = await link.list(
      {
        [SUPPLIER_MODULE]: { supplier_warehouse_id: input.supplierWarehouseId },
        [Modules.STOCK_LOCATION]: { stock_location_id: { $ne: null } },
      },
      {}
    )

    if (existingLinks.length > 0) {
      const stockLocationId = (existingLinks[0] as { stock_location_id: string }).stock_location_id
      const [existingLocation] = await stockLocationService.listStockLocations({
        id: stockLocationId,
      })

      if (existingLocation && existingLocation.name !== input.desiredName) {
        await stockLocationService.updateStockLocations(stockLocationId, {
          name: input.desiredName,
        })
        return new StepResponse(
          { stockLocationId, created: false, renamed: true },
          { kind: "renamed", stockLocationId, previousName: existingLocation.name }
        )
      }

      return new StepResponse(
        { stockLocationId, created: false, renamed: false },
        { kind: "noop" }
      )
    }

    const [location] = await stockLocationService.createStockLocations([
      { name: input.desiredName },
    ])
    await link.create([
      {
        [SUPPLIER_MODULE]: { supplier_warehouse_id: input.supplierWarehouseId },
        [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      },
    ])

    return new StepResponse(
      { stockLocationId: location.id, created: true, renamed: false },
      { kind: "created", stockLocationId: location.id, supplierWarehouseId: input.supplierWarehouseId }
    )
  },
  async (compensation: StepCompensation | undefined, { container }) => {
    if (!compensation || compensation.kind === "noop") {
      return
    }
    const stockLocationService = container.resolve(Modules.STOCK_LOCATION)

    if (compensation.kind === "renamed") {
      await stockLocationService.updateStockLocations(compensation.stockLocationId, {
        name: compensation.previousName,
      })
      return
    }

    // kind === "created": solo revertimos lo que ESTA invocación creó —
    // nunca un StockLocation que ya existía antes de este workflow.
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    await link.dismiss([
      {
        [SUPPLIER_MODULE]: { supplier_warehouse_id: compensation.supplierWarehouseId },
        [Modules.STOCK_LOCATION]: { stock_location_id: compensation.stockLocationId },
      },
    ])
    await stockLocationService.deleteStockLocations([compensation.stockLocationId])
  }
)

export const ensureStockLocationForWarehouseWorkflow = createWorkflow(
  "ensure-stock-location-for-warehouse",
  (input: EnsureStockLocationForWarehouseInput) => {
    const result = ensureStockLocationForWarehouseStep(input)
    return new WorkflowResponse(result)
  }
)
