import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { createRemoteLinkStep } from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../index"
import type SupplierModuleService from "../service"

/**
 * Único camino soportado para crear un SupplierProductMapping en código de
 * aplicación real (subscribers, admin routes, el futuro motor de sync) —
 * ver decisión Etapa 3 punto 1 en models/supplier-product-mapping.ts. Crea
 * la fila Y el Module Link hacia ProductVariant como un solo paso
 * compensable: si createRemoteLinkStep falla, el framework de Workflows
 * revierte automáticamente la fila recién creada (compensación de
 * createMappingRowStep); nunca puede quedar la fila sin su Link.
 *
 * Los tests de esta etapa SÍ llaman `service.createSupplierProductMappings()`
 * directo (sin este workflow) a propósito, para poder probar el modelo de
 * dominio en aislamiento sin levantar el módulo de Product — ningún código
 * de aplicación real debe hacer eso.
 */

export interface CreateSupplierProductMappingInput {
  supplier_id: string
  variant_id: string
  supplier_sku: string
  supplier_internal_ref?: string
  metadata?: Record<string, unknown>
}

export const createSupplierProductMappingRowStep = createStep(
  "create-supplier-product-mapping-row",
  async (input: CreateSupplierProductMappingInput, { container }) => {
    const service = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const mapping = await service.createSupplierProductMappings(input)
    return new StepResponse(mapping, mapping.id)
  },
  async (mappingId: string | undefined, { container }) => {
    if (!mappingId) {
      return
    }
    const service = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    await service.deleteSupplierProductMappings(mappingId)
  }
)

export const createSupplierProductMappingWorkflow = createWorkflow(
  "create-supplier-product-mapping",
  (input: CreateSupplierProductMappingInput) => {
    const mapping = createSupplierProductMappingRowStep(input)

    const links = transform({ input, mapping }, (data) => [
      {
        [Modules.PRODUCT]: { product_variant_id: data.input.variant_id },
        [SUPPLIER_MODULE]: { supplier_product_mapping_id: data.mapping.id },
      },
    ])
    createRemoteLinkStep(links)

    return new WorkflowResponse(mapping)
  }
)
