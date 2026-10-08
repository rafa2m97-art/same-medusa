import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Etapa 4, §3 — ProductVariant <-> InventoryItem en Medusa v2 real
 * (verificado contra @medusajs/core-flows/dist/product/workflows/
 * create-product-variants.js y @medusajs/core-flows/dist/inventory/steps/
 * attach-inventory-items.js): es un MODULE LINK nativo
 * ({[Modules.PRODUCT]: {variant_id}, [Modules.INVENTORY]: {inventory_item_id}}),
 * NO una columna en ProductVariant ni en InventoryItem. No se crea ningún
 * "SameInventoryItem" — este workflow solo garantiza que el Link nativo
 * exista, reutilizando InventoryItem si ya está.
 *
 * Cuándo YA existe sin que nosotros lo creemos: `createProductVariantsWorkflow`
 * de Medusa crea automáticamente un InventoryItem + Link cuando
 * `variant.manage_inventory === true` y no se pasó `inventory_items`
 * explícito — es decir, para cualquier variante creada por el flujo
 * estándar de Medusa, esto YA pasó. Este workflow es la red de seguridad
 * idempotente para los demás casos (variantes importadas por otra vía,
 * o que tenían manage_inventory=false y se activa después) — nunca crea
 * un segundo InventoryItem si el Link ya existe.
 */

export interface EnsureInventoryItemForVariantInput {
  variantId: string
  sku?: string
}

export interface EnsureInventoryItemForVariantOutput {
  inventoryItemId: string
  created: boolean
}

type StepCompensation =
  | { kind: "created"; inventoryItemId: string; variantId: string }
  | { kind: "noop" }

export const ensureInventoryItemForVariantStep = createStep(
  "ensure-inventory-item-for-variant",
  async (
    input: EnsureInventoryItemForVariantInput,
    { container }
  ): Promise<StepResponse<EnsureInventoryItemForVariantOutput, StepCompensation>> => {
    const link = container.resolve(ContainerRegistrationKeys.LINK)

    // link.list() identifica el módulo del OTRO lado por el nombre del
    // campo (Object.keys), no por su valor -- un objeto vacío no basta,
    // incluso cuando no se quiere restringir el valor (ver reporte Etapa 4).
    const existingLinks = await link.list(
      {
        [Modules.PRODUCT]: { variant_id: input.variantId },
        [Modules.INVENTORY]: { inventory_item_id: { $ne: null } },
      },
      {}
    )

    if (existingLinks.length > 0) {
      return new StepResponse(
        {
          inventoryItemId: (existingLinks[0] as { inventory_item_id: string }).inventory_item_id,
          created: false,
        },
        { kind: "noop" }
      )
    }

    const inventoryService = container.resolve(Modules.INVENTORY)
    const [item] = await inventoryService.createInventoryItems([
      { sku: input.sku ?? input.variantId },
    ])
    await link.create([
      {
        [Modules.PRODUCT]: { variant_id: input.variantId },
        [Modules.INVENTORY]: { inventory_item_id: item.id },
      },
    ])

    return new StepResponse(
      { inventoryItemId: item.id, created: true },
      { kind: "created", inventoryItemId: item.id, variantId: input.variantId }
    )
  },
  async (compensation: StepCompensation | undefined, { container }) => {
    if (!compensation || compensation.kind === "noop") {
      return
    }
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    await link.dismiss([
      {
        [Modules.PRODUCT]: { variant_id: compensation.variantId },
        [Modules.INVENTORY]: { inventory_item_id: compensation.inventoryItemId },
      },
    ])
    const inventoryService = container.resolve(Modules.INVENTORY)
    await inventoryService.deleteInventoryItems([compensation.inventoryItemId])
  }
)

export const ensureInventoryItemForVariantWorkflow = createWorkflow(
  "ensure-inventory-item-for-variant",
  (input: EnsureInventoryItemForVariantInput) => {
    const result = ensureInventoryItemForVariantStep(input)
    return new WorkflowResponse(result)
  }
)
