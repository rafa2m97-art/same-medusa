import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { PRICING_RULES_MODULE } from "../index"
import type PricingRulesModuleService from "../service"

/**
 * Único camino soportado para cambiar una PricingPolicy — nunca un UPDATE
 * directo a `margin_factor`/`tax_factor` de una fila existente (pedido
 * explícito, plan §7/§18: "cambiarla debe quedar auditado, no modificar
 * silenciosamente precios históricos"). Marca la política ACTIVA anterior
 * (mismo supplier_id/currency_code) como `superseded` y crea la nueva —
 * atómico, con compensación real si algo falla a medio camino.
 *
 * NO recalcula precios existentes — eso es el repricing masivo (plan
 * §19), explícitamente diferido. Esta workflow solo deja lista la nueva
 * política para que las PRÓXIMAS evaluaciones de costo la usen;
 * `PricingState.last_applied_policy_code` sigue apuntando a la política
 * vieja para cualquier precio ya aceptado, hasta que un nuevo costo (o un
 * futuro job de repricing) lo vuelva a evaluar.
 */

export interface CreatePricingPolicyVersionInput {
  code: string
  supplierId: string | null
  currencyCode: string
  marginFactor: number
  taxFactor: number
  /**
   * Banda de variación segura día-a-día (Etapa 5.1, plan §15) — SIEMPRE
   * explícita en cada versión, nunca un default silencioso: es
   * precisamente lo que el usuario pidió sacar de "magic number".
   */
  minChangeRatio: number
  maxChangeRatio: number
}

const supersedePreviousPolicyStep = createStep(
  "supersede-previous-pricing-policy",
  async (input: CreatePricingPolicyVersionInput, { container }) => {
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)

    const previousActive = await pricingRulesService.listPricingPolicies({
      supplier_id: input.supplierId,
      currency_code: input.currencyCode,
      status: "active",
    })

    if (previousActive.length) {
      await pricingRulesService.updatePricingPolicies(
        previousActive.map((p) => ({ id: p.id, status: "superseded" as const }))
      )
    }

    return new StepResponse(
      previousActive.map((p) => p.id),
      previousActive.map((p) => p.id)
    )
  },
  async (supersededIds, { container }) => {
    if (!supersededIds?.length) return
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
    await pricingRulesService.updatePricingPolicies(
      supersededIds.map((id) => ({ id, status: "active" as const }))
    )
  }
)

const createNewPolicyStep = createStep(
  "create-new-pricing-policy",
  async (input: CreatePricingPolicyVersionInput, { container }) => {
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
    const created = await pricingRulesService.createPricingPolicies({
      code: input.code,
      supplier_id: input.supplierId,
      currency_code: input.currencyCode,
      margin_factor: input.marginFactor,
      tax_factor: input.taxFactor,
      min_change_ratio: input.minChangeRatio,
      max_change_ratio: input.maxChangeRatio,
      status: "active",
      effective_from: new Date(),
    })
    return new StepResponse(created, created.id)
  },
  async (createdId, { container }) => {
    if (!createdId) return
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
    await pricingRulesService.deletePricingPolicies([createdId])
  }
)

export const createPricingPolicyVersionWorkflow = createWorkflow(
  "create-pricing-policy-version",
  (input: CreatePricingPolicyVersionInput) => {
    supersedePreviousPolicyStep(input)
    const created = createNewPolicyStep(input)
    return new WorkflowResponse(created)
  }
)
