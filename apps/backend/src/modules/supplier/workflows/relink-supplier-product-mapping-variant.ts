import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  createRemoteLinkStep,
  dismissRemoteLinkStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../index"
import type SupplierModuleService from "../service"

/**
 * Único camino soportado para RE-APUNTAR un SupplierProductMapping
 * existente a otra ProductVariant (ver decisión Etapa 3 punto 1). Nunca se
 * debe hacer `updateSupplierProductMappings({variant_id: ...})` directo en
 * código de aplicación real — eso dejaría el Link apuntando a la variante
 * vieja mientras variant_id ya dice la nueva.
 *
 * Nota: esto es sobre re-apuntar la ASOCIACIÓN con Medusa (qué variante es
 * este producto), no sobre la recodificación de referencia del PROVEEDOR
 * (supplier_internal_ref) — ese caso (Exel cambia su referencia interna
 * manteniendo el mismo SKU) no toca el Link en absoluto y ya se cubre con
 * un update directo normal (ver test "mantiene supplier_sku y
 * supplier_internal_ref..." de Etapa 2).
 */

export interface RelinkSupplierProductMappingVariantInput {
  mapping_id: string
  previous_variant_id: string
  new_variant_id: string
}

const updateMappingVariantIdStep = createStep(
  "update-supplier-product-mapping-variant-id",
  async (input: RelinkSupplierProductMappingVariantInput, { container }) => {
    const service = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const [updated] = await service.updateSupplierProductMappings([
      { id: input.mapping_id, variant_id: input.new_variant_id },
    ])
    return new StepResponse(updated, {
      mappingId: input.mapping_id,
      previousVariantId: input.previous_variant_id,
    })
  },
  async (
    compensationInput:
      | { mappingId: string; previousVariantId: string }
      | undefined,
    { container }
  ) => {
    if (!compensationInput) {
      return
    }
    const service = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    await service.updateSupplierProductMappings([
      {
        id: compensationInput.mappingId,
        variant_id: compensationInput.previousVariantId,
      },
    ])
  }
)

export const relinkSupplierProductMappingVariantWorkflow = createWorkflow(
  "relink-supplier-product-mapping-variant",
  (input: RelinkSupplierProductMappingVariantInput) => {
    const updated = updateMappingVariantIdStep(input)

    const oldLinks = transform({ input }, (data) => [
      {
        [Modules.PRODUCT]: { product_variant_id: data.input.previous_variant_id },
        [SUPPLIER_MODULE]: { supplier_product_mapping_id: data.input.mapping_id },
      },
    ])
    dismissRemoteLinkStep(oldLinks)

    const newLinks = transform({ input }, (data) => [
      {
        [Modules.PRODUCT]: { product_variant_id: data.input.new_variant_id },
        [SUPPLIER_MODULE]: { supplier_product_mapping_id: data.input.mapping_id },
      },
    ])
    createRemoteLinkStep(newLinks)

    return new WorkflowResponse(updated)
  }
)
