import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { upsertVariantPricesWorkflow } from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUPPLIER_MODULE } from "../../supplier"
import type SupplierModuleService from "../../supplier/service"
import { PRICING_RULES_MODULE } from "../index"
import type PricingRulesModuleService from "../service"
import { classifyPriceChange, type PricingPolicyInput } from "../rules/classify-price-change"
import {
  evaluateCandidateEligibility,
  PrimarySupplierStrategy,
  type PricingSourceCandidate,
} from "../rules/pricing-source-strategy"
import { resolveCommerceAuditEmitter } from "../../commerce-audit/events"

/**
 * Etapa 5.1 — elimina "el último proveedor que sincronizó define el
 * precio". Cada llamada (sin importar de qué proveedor venga el costo
 * nuevo) hace lo mismo: (1) guarda el SupplierCost de ESE proveedor,
 * nunca pisando el de otro; (2) re-selecciona, para la VARIANT completa,
 * cuál proveedor es la fuente de pricing (hoy: PRIMARY_SUPPLIER); (3)
 * solo si la fuente SELECCIONADA produce un cambio de precio razonable,
 * actualiza Medusa Pricing. El resultado es determinista — no depende de
 * qué sync llegó último (ver pricing-source-strategy.ts).
 *
 * Reutiliza `upsertVariantPricesWorkflow` nativo (igual que Etapa 4
 * reutilizó `batchInventoryItemLevelsWorkflow`).
 */

export interface ApplySupplierPricingInput {
  supplierProductMappingId: string
  syncRunId?: string
  cost: { amount: number; currencyCode: string }
}

/**
 * Persiste el SupplierCost del mapping que disparó esta llamada. SIEMPRE
 * corre, sin importar si ese proveedor termina siendo la fuente elegida
 * — cada proveedor conserva su propio costo, nunca pisa el de otro
 * (plan §2).
 */
const recordSupplierCostStep = createStep(
  "record-supplier-cost",
  async (input: ApplySupplierPricingInput, { container }) => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)

    const mapping = await supplierService.retrieveSupplierProductMapping(
      input.supplierProductMappingId
    )
    const [existingCost] = await pricingRulesService.listSupplierCosts({
      supplier_product_mapping_id: mapping.id,
    })
    const previousCostAmount = existingCost ? Number(existingCost.amount) : null

    // NaN/Infinity no son valores que una columna bigNumber pueda
    // almacenar ("Cannot set value NaN for amount") — se tratan como "el
    // proveedor no mandó nada utilizable", nunca se escriben como última
    // lectura. `evaluateCandidateEligibility` de todas formas marca esta
    // fuente como inelegible (missing_cost/invalid_cost) más abajo.
    const isRepresentableAmount = Number.isFinite(input.cost.amount)

    if (
      isRepresentableAmount &&
      (!existingCost ||
        Number(existingCost.amount) !== input.cost.amount ||
        existingCost.currency_code !== input.cost.currencyCode)
    ) {
      auditEmitter.emit({
        eventType: "SUPPLIER_COST_CHANGED",
        correlationId: input.syncRunId ?? mapping.id,
        supplierProductMappingId: mapping.id,
        syncRunId: input.syncRunId,
        details: { before: previousCostAmount, after: input.cost.amount },
        occurredAt: new Date(),
      })
    }
    if (isRepresentableAmount) {
      if (existingCost) {
        await pricingRulesService.updateSupplierCosts([
          {
            id: existingCost.id,
            currency_code: input.cost.currencyCode,
            amount: input.cost.amount,
            source_sync_run_id: input.syncRunId ?? null,
            effective_at: new Date(),
          },
        ])
      } else {
        await pricingRulesService.createSupplierCosts({
          supplier_product_mapping_id: mapping.id,
          currency_code: input.cost.currencyCode,
          amount: input.cost.amount,
          source_sync_run_id: input.syncRunId ?? null,
          effective_at: new Date(),
        })
      }
    }

    return new StepResponse(
      { mappingId: mapping.id, variantId: mapping.variant_id as string },
      null
    )
  }
)

interface ResolvedPricingContext {
  proceed: boolean
  rejectReason?: string
  reviewReason?: string
  variantId: string
  productId?: string
  publicPriceAmount?: number
  policyCode?: string
  strategy: "PRIMARY_SUPPLIER"
  selectedSupplierId?: string
  selectedMappingId?: string
  selectedSupplierCostId?: string
  existingPriceId?: string | null
  hasExistingPriceSet?: boolean
  previousAcceptedAmount?: number | null
  previousSourceSupplierId?: string | null
}

const MAX_COST_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * El núcleo de Etapa 5.1: reúne TODOS los SupplierProductMapping de la
 * VARIANT (no solo el que disparó esta llamada), construye un
 * `PricingSourceCandidate` por cada uno, corre la estrategia de
 * selección, y solo si hay una fuente elegible evalúa el cambio de
 * precio. Las estructuras de `pricing-source-strategy.ts`/
 * `classify-price-change.ts` son puras — todo el I/O vive aquí.
 */
const selectAndEvaluatePricingStep = createStep(
  "select-and-evaluate-pricing",
  async (
    input: { variantId: string; syncRunId?: string },
    { container }
  ): Promise<StepResponse<ResolvedPricingContext, null>> => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const supplierService = container.resolve<SupplierModuleService>(SUPPLIER_MODULE)
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
    const correlationId = input.syncRunId ?? input.variantId

    const mappings = await supplierService.listSupplierProductMappings({
      variant_id: input.variantId,
    })
    const mappingIds = mappings.map((m) => m.id)
    const supplierIds = [...new Set(mappings.map((m) => m.supplier_id))]

    const [suppliers, states, costs] = await Promise.all([
      supplierService.listSuppliers({ id: supplierIds }),
      supplierService.listSupplierProductStates({ supplier_product_mapping_id: mappingIds }),
      pricingRulesService.listSupplierCosts({ supplier_product_mapping_id: mappingIds }),
    ])
    const supplierById = new Map(suppliers.map((s) => [s.id, s]))
    const stateByMappingId = new Map(states.map((s) => [s.supplier_product_mapping_id, s]))
    const costByMappingId = new Map(costs.map((c) => [c.supplier_product_mapping_id, c]))

    // Política por defecto -- gobierna la moneda requerida para
    // elegibilidad. Hoy SAME solo opera en MXN (plan §15); una fuente en
    // otra moneda es inelegible, nunca se asume conversión.
    const [defaultPolicy] = await pricingRulesService.listPricingPolicies({
      supplier_id: null,
      status: "active",
    })

    const candidates: PricingSourceCandidate[] = mappings.map((mapping) => {
      const supplier = supplierById.get(mapping.supplier_id)
      const state = stateByMappingId.get(mapping.id)
      const cost = costByMappingId.get(mapping.id)
      return {
        supplierId: mapping.supplier_id,
        supplierCode: supplier?.code ?? "",
        mappingId: mapping.id,
        isPrimaryPricingSource: supplier?.is_primary_pricing_source ?? false,
        supplierStatus: (supplier?.status as "active" | "inactive") ?? "inactive",
        mappingStatus: mapping.status as "active" | "inactive",
        supplierProductStateStatus: (state?.status as "active" | "quarantined" | undefined) ?? null,
        costAmount: cost ? Number(cost.amount) : null,
        costCurrencyCode: cost?.currency_code ?? null,
        costEffectiveAt: cost?.effective_at ?? null,
      }
    })

    const evaluated = candidates.map((c) =>
      evaluateCandidateEligibility(c, {
        requiredCurrencyCode: defaultPolicy?.currency_code ?? "mxn",
        maxCostAgeMs: MAX_COST_AGE_MS,
        now: new Date(),
      })
    )

    const strategy = new PrimarySupplierStrategy()
    const selection = strategy.selectSource(evaluated)

    const [pricingState] = await pricingRulesService.listPricingStates({
      variant_id: input.variantId,
    })
    const previousAcceptedAmount =
      pricingState?.last_accepted_amount == null ? null : Number(pricingState.last_accepted_amount)
    const previousSourceSupplierId = pricingState?.source_supplier_id ?? null

    if (!selection.selected) {
      auditEmitter.emit({
        eventType: "PRICING_SOURCE_UNAVAILABLE",
        correlationId,
        syncRunId: input.syncRunId,
        details: { strategy: selection.strategy, reason: selection.reason },
        occurredAt: new Date(),
      })
      return new StepResponse(
        {
          proceed: false,
          rejectReason: selection.reason,
          variantId: input.variantId,
          strategy: selection.strategy,
          previousAcceptedAmount,
          previousSourceSupplierId,
        },
        null
      )
    }

    auditEmitter.emit({
      eventType: "PRICING_SOURCE_SELECTED",
      correlationId,
      syncRunId: input.syncRunId,
      details: {
        strategy: selection.strategy,
        supplierId: selection.selected.supplierId,
        mappingId: selection.selected.mappingId,
      },
      occurredAt: new Date(),
    })
    if (previousSourceSupplierId && previousSourceSupplierId !== selection.selected.supplierId) {
      auditEmitter.emit({
        eventType: "PRICING_SOURCE_CHANGED",
        correlationId,
        syncRunId: input.syncRunId,
        details: { before: previousSourceSupplierId, after: selection.selected.supplierId },
        occurredAt: new Date(),
      })
    }

    // Política del proveedor SELECCIONADO: propia primero, si no existe
    // cae a la de por defecto -- mismo patrón de resolución de Etapa 5.
    const [supplierSpecificPolicy] = await pricingRulesService.listPricingPolicies({
      supplier_id: selection.selected.supplierId,
      status: "active",
    })
    const policy = supplierSpecificPolicy ?? defaultPolicy
    if (!policy) {
      return new StepResponse(
        {
          proceed: false,
          rejectReason: "no_active_policy",
          variantId: input.variantId,
          strategy: selection.strategy,
          previousAcceptedAmount,
          previousSourceSupplierId,
        },
        null
      )
    }

    const policyInput: PricingPolicyInput = {
      code: policy.code,
      currencyCode: policy.currency_code,
      marginFactor: Number(policy.margin_factor),
      taxFactor: Number(policy.tax_factor),
      minChangeRatio: Number(policy.min_change_ratio),
      maxChangeRatio: Number(policy.max_change_ratio),
    }

    const classification = classifyPriceChange({
      costAmount: selection.selected.costAmount!,
      policy: policyInput,
      lastAcceptedAmount: previousAcceptedAmount,
    })

    if (classification.action === "REVIEW") {
      auditEmitter.emit({
        eventType: "PRICE_CHANGE_REQUIRES_REVIEW",
        correlationId,
        syncRunId: input.syncRunId,
        details: {
          reason: classification.reason,
          computedAmount: classification.computedAmount,
          previousAmount: classification.previousAmount,
          ratio: classification.ratio,
        },
        occurredAt: new Date(),
      })
      return new StepResponse(
        {
          proceed: false,
          reviewReason: classification.reason,
          variantId: input.variantId,
          strategy: selection.strategy,
          previousAcceptedAmount,
          previousSourceSupplierId,
        },
        null
      )
    }

    auditEmitter.emit({
      eventType: "PUBLIC_PRICE_CALCULATED",
      correlationId,
      syncRunId: input.syncRunId,
      details: { amount: classification.publicPriceAmount, policyCode: classification.policyCode },
      occurredAt: new Date(),
    })

    const productService = container.resolve(Modules.PRODUCT)
    const [variant] = await productService.listProductVariants({ id: input.variantId })

    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const existingPriceSetLinks = await link.list(
      {
        [Modules.PRODUCT]: { variant_id: input.variantId },
        [Modules.PRICING]: { price_set_id: { $ne: null } },
      },
      {}
    )
    let existingPriceId: string | null = null
    const hasExistingPriceSet = existingPriceSetLinks.length > 0
    if (hasExistingPriceSet) {
      const priceSetId = (existingPriceSetLinks[0] as { price_set_id: string }).price_set_id
      const pricingService = container.resolve(Modules.PRICING)
      const [existingPrice] = await pricingService.listPrices({
        price_set_id: [priceSetId],
        currency_code: [policy.currency_code],
      })
      existingPriceId = existingPrice?.id ?? null
    }

    const selectedCost = costByMappingId.get(selection.selected.mappingId)

    return new StepResponse(
      {
        proceed: true,
        variantId: input.variantId,
        productId: variant.product_id as string,
        publicPriceAmount: classification.publicPriceAmount,
        policyCode: classification.policyCode,
        strategy: selection.strategy,
        selectedSupplierId: selection.selected.supplierId,
        selectedMappingId: selection.selected.mappingId,
        selectedSupplierCostId: selectedCost?.id,
        existingPriceId,
        hasExistingPriceSet,
        previousAcceptedAmount,
        previousSourceSupplierId,
      },
      null
    )
  }
)

interface MarkPricingStateInput {
  ctx: ResolvedPricingContext
}

const markPricingStateStep = createStep(
  "mark-pricing-state-evaluated",
  async (input: MarkPricingStateInput, { container }) => {
    const auditEmitter = resolveCommerceAuditEmitter(container)
    const { ctx } = input
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)

    const [existingState] = await pricingRulesService.listPricingStates({
      variant_id: ctx.variantId,
    })
    const previous = existingState
      ? {
          last_classification: existingState.last_classification,
          last_classification_reason: existingState.last_classification_reason,
          last_strategy: existingState.last_strategy,
          source_supplier_id: existingState.source_supplier_id,
          source_mapping_id: existingState.source_mapping_id,
          source_supplier_cost_id: existingState.source_supplier_cost_id,
          last_accepted_amount: existingState.last_accepted_amount,
          last_accepted_cost_amount: existingState.last_accepted_cost_amount,
          last_applied_policy_code: existingState.last_applied_policy_code,
          last_accepted_at: existingState.last_accepted_at,
        }
      : null

    const now = new Date()
    const common = {
      last_evaluated_at: now,
      last_strategy: ctx.strategy,
      last_classification: ctx.proceed ? ("ACCEPT" as const) : ctx.reviewReason ? ("REVIEW" as const) : ("REJECT" as const),
      last_classification_reason: ctx.rejectReason ?? ctx.reviewReason ?? null,
    }

    let stateId: string
    if (ctx.proceed) {
      const acceptedFields = {
        ...common,
        source_supplier_id: ctx.selectedSupplierId ?? null,
        source_mapping_id: ctx.selectedMappingId ?? null,
        source_supplier_cost_id: ctx.selectedSupplierCostId ?? null,
        last_accepted_amount: ctx.publicPriceAmount,
        last_applied_policy_code: ctx.policyCode,
        last_accepted_at: now,
      }
      if (existingState) {
        await pricingRulesService.updatePricingStates([{ id: existingState.id, ...acceptedFields }])
        stateId = existingState.id
      } else {
        const created = await pricingRulesService.createPricingStates({
          variant_id: ctx.variantId,
          ...acceptedFields,
        })
        stateId = created.id
      }

      auditEmitter.emit({
        eventType: "PUBLIC_PRICE_UPDATED",
        correlationId: ctx.variantId,
        details: { before: ctx.previousAcceptedAmount, after: ctx.publicPriceAmount },
        occurredAt: now,
      })
    } else {
      // REVIEW/REJECT: Last Known Good se conserva -- NUNCA se tocan los
      // campos source_*/last_accepted_* aquí.
      if (existingState) {
        await pricingRulesService.updatePricingStates([{ id: existingState.id, ...common }])
        stateId = existingState.id
      } else {
        const created = await pricingRulesService.createPricingStates({
          variant_id: ctx.variantId,
          ...common,
        })
        stateId = created.id
      }
    }

    return new StepResponse(
      { stateId, variantId: ctx.variantId },
      { stateId, previous, existedBefore: !!existingState }
    )
  },
  async (revert, { container }) => {
    if (!revert) return
    const pricingRulesService =
      container.resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
    if (revert.previous) {
      await pricingRulesService.updatePricingStates([{ id: revert.stateId, ...revert.previous }])
    } else if (!revert.existedBefore) {
      await pricingRulesService.deletePricingStates([revert.stateId])
    }
  }
)

export const applySupplierPricingWorkflow = createWorkflow(
  "apply-supplier-pricing",
  (input: ApplySupplierPricingInput) => {
    const recorded = recordSupplierCostStep(input)

    const evaluateInput = transform({ recorded, input }, (data) => ({
      variantId: data.recorded.variantId,
      syncRunId: data.input.syncRunId,
    }))
    const ctx = selectAndEvaluatePricingStep(evaluateInput)

    const variantPricesInput = transform({ ctx }, (data) => {
      if (!data.ctx.proceed) {
        return { variantPrices: [], previousVariantIds: [] }
      }
      const priceEntry = data.ctx.existingPriceId
        ? { id: data.ctx.existingPriceId, amount: data.ctx.publicPriceAmount! }
        : { amount: data.ctx.publicPriceAmount!, currency_code: "mxn" }
      return {
        variantPrices: [
          {
            variant_id: data.ctx.variantId,
            product_id: data.ctx.productId!,
            prices: [priceEntry],
          },
        ],
        previousVariantIds: data.ctx.hasExistingPriceSet ? [data.ctx.variantId] : [],
      }
    })
    upsertVariantPricesWorkflow.runAsStep({ input: variantPricesInput })

    const marked = markPricingStateStep(transform({ ctx }, (data) => ({ ctx: data.ctx })))

    return new WorkflowResponse(
      transform({ ctx, marked }, (data) => ({
        proceed: data.ctx.proceed,
        rejectReason: data.ctx.rejectReason,
        reviewReason: data.ctx.reviewReason,
        publicPriceAmount: data.ctx.publicPriceAmount,
        variantId: data.ctx.variantId,
        sourceSupplierId: data.ctx.selectedSupplierId,
        sourceMappingId: data.ctx.selectedMappingId,
      }))
    )
  }
)
