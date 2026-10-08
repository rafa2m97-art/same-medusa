import * as fs from "fs"
import * as path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { asValue } from "@medusajs/framework/awilix"
import { SUPPLIER_MODULE } from "../../src/modules/supplier"
import type SupplierModuleService from "../../src/modules/supplier/service"
import { PRICING_RULES_MODULE } from "../../src/modules/pricing-rules"
import type PricingRulesModuleService from "../../src/modules/pricing-rules/service"
import { createSupplierProductMappingWorkflow } from "../../src/modules/supplier/workflows/create-supplier-product-mapping"
import { applySupplierPricingWorkflow } from "../../src/modules/pricing-rules/workflows/apply-supplier-pricing"
import { createPricingPolicyVersionWorkflow } from "../../src/modules/pricing-rules/workflows/create-pricing-policy-version"
import { classifyConflicts } from "../../src/modules/supplier/reconciliation/classify-conflicts"
import {
  COMMERCE_AUDIT_EMITTER,
  InMemoryCommerceAuditEmitter,
} from "../../src/modules/commerce-audit/events"

jest.setTimeout(300000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const container = () => getContainer()

    async function createVariant(title: string, sku?: string) {
      const productService = container().resolve(Modules.PRODUCT)
      const [product] = await productService.createProducts([
        { title: `Product ${title}`, status: "draft" },
      ])
      const [variant] = await productService.createProductVariants([
        { title, sku: sku ?? title, product_id: product.id },
      ])
      return variant.id as string
    }

    async function createSupplier(code: string, opts: { isPrimary?: boolean } = {}) {
      const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
      return supplierService.createSuppliers({
        code,
        name: code,
        adapter_key: code,
        is_primary_pricing_source: opts.isPrimary ?? false,
      })
    }

    async function createMapping(supplierId: string, variantId: string, sku: string) {
      const { result } = await createSupplierProductMappingWorkflow(container()).run({
        input: { supplier_id: supplierId, variant_id: variantId, supplier_sku: sku },
      })
      return result
    }

    async function createDefaultPolicy(
      code = "exel-default-v1",
      overrides: Partial<{
        supplierId: string | null
        marginFactor: number
        taxFactor: number
        minChangeRatio: number
        maxChangeRatio: number
      }> = {}
    ) {
      const { result } = await createPricingPolicyVersionWorkflow(container()).run({
        input: {
          code,
          supplierId: overrides.supplierId ?? null,
          currencyCode: "mxn",
          marginFactor: overrides.marginFactor ?? 0.95,
          taxFactor: overrides.taxFactor ?? 1.16,
          minChangeRatio: overrides.minChangeRatio ?? 0.5,
          maxChangeRatio: overrides.maxChangeRatio ?? 2.0,
        },
      })
      return result
    }

    async function getPriceSetIdForVariant(variantId: string): Promise<string | null> {
      const link = container().resolve(ContainerRegistrationKeys.LINK)
      const links = await link.list(
        {
          [Modules.PRODUCT]: { variant_id: variantId },
          [Modules.PRICING]: { price_set_id: { $ne: null } },
        },
        {}
      )
      return links.length ? ((links[0] as any).price_set_id as string) : null
    }

    async function getMxnPrice(variantId: string) {
      const priceSetId = await getPriceSetIdForVariant(variantId)
      if (!priceSetId) return null
      const pricingService = container().resolve(Modules.PRICING)
      const [price] = await pricingService.listPrices({
        price_set_id: [priceSetId],
        currency_code: ["mxn"],
      })
      return price ?? null
    }

    async function getPricingState(variantId: string) {
      const pricingRulesService = container().resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
      const [state] = await pricingRulesService.listPricingStates({ variant_id: variantId })
      return state ?? null
    }

    describe("Etapa 5.1, §2 — SupplierCost independiente por proveedor", () => {
      it("1/2/3. EXEL y SYSCOM mantienen SupplierCost independiente; actualizar uno no pisa al otro", async () => {
        await createDefaultPolicy("v1-indep")
        const variantId = await createVariant("Variant Independent Cost")
        const exel = await createSupplier("exel_indep", { isPrimary: true })
        const syscom = await createSupplier("syscom_indep")
        const mappingExel = await createMapping(exel.id, variantId, "SKU-EXEL-INDEP")
        const mappingSyscom = await createMapping(syscom.id, variantId, "SKU-SYSCOM-INDEP")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 90, currencyCode: "mxn" } },
        })

        const pricingRulesService = container().resolve<PricingRulesModuleService>(PRICING_RULES_MODULE)
        const [costExel] = await pricingRulesService.listSupplierCosts({
          supplier_product_mapping_id: mappingExel.id,
        })
        const [costSyscom] = await pricingRulesService.listSupplierCosts({
          supplier_product_mapping_id: mappingSyscom.id,
        })
        expect(Number(costExel.amount)).toEqual(100)
        expect(Number(costSyscom.amount)).toEqual(90)

        // Actualizar Syscom otra vez no debe tocar el costo de Exel.
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 80, currencyCode: "mxn" } },
        })
        const [costExelAfter] = await pricingRulesService.listSupplierCosts({
          supplier_product_mapping_id: mappingExel.id,
        })
        expect(Number(costExelAfter.amount)).toEqual(100)
      })
    })

    describe("Etapa 5.1, §5-§7 — PRIMARY_SUPPLIER determinista", () => {
      it("6. sync de supplier NO-primary no modifica PublicPrice", async () => {
        await createDefaultPolicy("v1-nonprimary")
        const variantId = await createVariant("Variant Non Primary Sync")
        const exel = await createSupplier("exel_nonprimary", { isPrimary: true })
        const syscom = await createSupplier("syscom_nonprimary")
        const mappingExel = await createMapping(exel.id, variantId, "SKU-EXEL-NP")
        const mappingSyscom = await createMapping(syscom.id, variantId, "SKU-SYSCOM-NP")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const priceAfterExel = await getMxnPrice(variantId)
        expect(Number(priceAfterExel!.amount)).toEqual(123)

        const { result } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 80, currencyCode: "mxn" } },
        })
        expect(result.sourceSupplierId).toEqual(exel.id)

        const priceAfterSyscom = await getMxnPrice(variantId)
        expect(Number(priceAfterSyscom!.amount)).toEqual(123)
      })

      it("7. sync de primary SÍ puede modificar PublicPrice", async () => {
        await createDefaultPolicy("v1-primary-sync")
        const variantId = await createVariant("Variant Primary Sync")
        const exel = await createSupplier("exel_primary_sync", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-EXEL-PS")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(123)

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 105, currencyCode: "mxn" } },
        })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(129)
      })

      it("8. primary quarantined no actualiza precio -- Last Known Good se conserva", async () => {
        await createDefaultPolicy("v1-primary-quarantined")
        const variantId = await createVariant("Variant Primary Quarantined")
        const exel = await createSupplier("exel_quarantined", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-EXEL-Q")
        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await supplierService.createSupplierProductStates({
          supplier_product_mapping_id: mapping.id,
          status: "quarantined",
          reason: "TOTAL_WAREHOUSE_MISMATCH",
        })

        const { result } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 999, currencyCode: "mxn" } },
        })
        expect(result).toMatchObject({ proceed: false, rejectReason: "quarantined" })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(123)
      })

      it("9. primary inactive no actualiza precio", async () => {
        await createDefaultPolicy("v1-primary-inactive")
        const variantId = await createVariant("Variant Primary Inactive")
        const exel = await createSupplier("exel_inactive", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-EXEL-INACTIVE")
        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await supplierService.updateSuppliers([{ id: exel.id, status: "inactive" }])

        const { result } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 999, currencyCode: "mxn" } },
        })
        expect(result).toMatchObject({ proceed: false, rejectReason: "supplier_inactive" })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(123)
      })

      it("10. primary sin SupplierCost conserva Last Known Good", async () => {
        await createDefaultPolicy("v1-primary-nocost")
        const variantId = await createVariant("Variant Primary No Cost")
        const exel = await createSupplier("exel_nocost", { isPrimary: true })
        const syscom = await createSupplier("syscom_nocost")
        const mappingExel = await createMapping(exel.id, variantId, "SKU-EXEL-NOCOST")
        await createMapping(syscom.id, variantId, "SKU-SYSCOM-NOCOST")

        // EXEL nunca manda un costo válido -- SYSCOM sí, pero no es primary.
        const { result } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: NaN, currencyCode: "mxn" } },
        })
        expect(result.proceed).toEqual(false)
        expect(await getMxnPrice(variantId)).toBeNull()
      })

      it("11. primary con currency inválida conserva Last Known Good", async () => {
        await createDefaultPolicy("v1-primary-badcurrency")
        const variantId = await createVariant("Variant Primary Bad Currency")
        const exel = await createSupplier("exel_badcurrency", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-EXEL-BADCUR")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const { result } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "usd" } },
        })
        expect(result).toMatchObject({ proceed: false, rejectReason: "unsupported_currency" })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(123)
      })
    })

    describe("Etapa 5.1, §19 — independencia del orden de sync (la prueba más importante)", () => {
      it("Secuencias A, B y C producen el MISMO PublicPrice y la MISMA fuente, sin importar el orden", async () => {
        await createDefaultPolicy("v1-order-independence")

        async function runSequence(order: "A" | "B" | "C") {
          const variantId = await createVariant(`Variant Order ${order}`)
          const exel = await createSupplier(`exel_order_${order}`, { isPrimary: true })
          const syscom = await createSupplier(`syscom_order_${order}`)
          const mappingExel = await createMapping(exel.id, variantId, `SKU-EXEL-ORDER-${order}`)
          const mappingSyscom = await createMapping(syscom.id, variantId, `SKU-SYSCOM-ORDER-${order}`)

          const syncExel = () =>
            applySupplierPricingWorkflow(container()).run({
              input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
            })
          const syncSyscom = () =>
            applySupplierPricingWorkflow(container()).run({
              input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 90, currencyCode: "mxn" } },
            })

          if (order === "A") {
            await syncExel()
            await syncSyscom()
          } else if (order === "B") {
            await syncSyscom()
            await syncExel()
          } else {
            await syncExel()
            await syncSyscom()
            await syncSyscom() // retry
          }

          const price = await getMxnPrice(variantId)
          const state = await getPricingState(variantId)
          return { price: Number(price!.amount), sourceSupplierId: state!.source_supplier_id, exelId: exel.id }
        }

        const a = await runSequence("A")
        const b = await runSequence("B")
        const c = await runSequence("C")

        expect(a.price).toEqual(123)
        expect(b.price).toEqual(123)
        expect(c.price).toEqual(123)
        expect(a.sourceSupplierId).toEqual(a.exelId)
        expect(b.sourceSupplierId).toEqual(b.exelId)
        expect(c.sourceSupplierId).toEqual(c.exelId)
      })
    })

    describe("Etapa 5.1, §9 — trazabilidad de origen en PricingState", () => {
      it("13/14/15/16. PricingState registra source_supplier_id, source_mapping_id, policy version y strategy", async () => {
        await createDefaultPolicy("v1-traceability")
        const variantId = await createVariant("Variant Traceability")
        const exel = await createSupplier("exel_traceability", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-EXEL-TRACE")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const state = await getPricingState(variantId)
        expect(state!.source_supplier_id).toEqual(exel.id)
        expect(state!.source_mapping_id).toEqual(mapping.id)
        expect(state!.last_applied_policy_code).toEqual("v1-traceability")
        expect(state!.last_strategy).toEqual("PRIMARY_SUPPLIER")
        expect(state!.source_supplier_cost_id).toBeTruthy()
      })
    })

    describe("Etapa 5.1, §12 — cambio de proveedor primario", () => {
      it("12. cambiar el primario de EXEL a SYSCOM permite recalcular mediante el mismo workflow explícito", async () => {
        await createDefaultPolicy("v1-change-primary")
        const variantId = await createVariant("Variant Change Primary")
        const exel = await createSupplier("exel_change_primary", { isPrimary: true })
        const syscom = await createSupplier("syscom_change_primary")
        const mappingExel = await createMapping(exel.id, variantId, "SKU-EXEL-CHANGE")
        const mappingSyscom = await createMapping(syscom.id, variantId, "SKU-SYSCOM-CHANGE")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 90, currencyCode: "mxn" } },
        })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(123) // de EXEL

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        await supplierService.updateSuppliers([
          { id: exel.id, is_primary_pricing_source: false },
          { id: syscom.id, is_primary_pricing_source: true },
        ])

        // "select source again -> calculate -> anomaly guard -> apply":
        // se vuelve a invocar el MISMO workflow explícito con cualquiera
        // de los dos mappings -- la reselección es lo que importa, no
        // cuál mapping disparó la llamada.
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 90, currencyCode: "mxn" } },
        })

        const price = await getMxnPrice(variantId)
        const state = await getPricingState(variantId)
        expect(Number(price!.amount)).toEqual(110) // ceil(90/0.95*1.16)
        expect(state!.source_supplier_id).toEqual(syscom.id)
      })
    })

    describe("Etapa 5.1, §21-§23 — anomaly threshold versionado, ACCEPT/REVIEW", () => {
      it("21/22/23. el umbral viene de PricingPolicy -- la MISMA variación es ACCEPT con una banda y REVIEW con otra", async () => {
        // Policy A: banda estrecha -- 90->123 dispara REVIEW si el ratio excede.
        await createDefaultPolicy("v1-narrow-band", { minChangeRatio: 0.99, maxChangeRatio: 1.01 })
        const variantNarrow = await createVariant("Variant Narrow Band")
        const exelNarrow = await createSupplier("exel_narrow_band", { isPrimary: true })
        const mappingNarrow = await createMapping(exelNarrow.id, variantNarrow, "SKU-NARROW")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingNarrow.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const { result: narrowResult } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingNarrow.id, cost: { amount: 105, currencyCode: "mxn" } },
        })
        expect(narrowResult.proceed).toEqual(false)
        expect(narrowResult.reviewReason).toEqual("extreme_price_change")

        // Policy B: banda ancha -- la MISMA variación (100 -> 105) ACCEPT.
        await createDefaultPolicy("v1-wide-band", { minChangeRatio: 0.1, maxChangeRatio: 10 })
        const variantWide = await createVariant("Variant Wide Band")
        const exelWide = await createSupplier("exel_wide_band", { isPrimary: true })
        const mappingWide = await createMapping(exelWide.id, variantWide, "SKU-WIDE")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingWide.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const { result: wideResult } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingWide.id, cost: { amount: 105, currencyCode: "mxn" } },
        })
        expect(wideResult.proceed).toEqual(true)
      })

      it("25. REVIEW conserva Last Known Good (no se toca el Price existente)", async () => {
        await createDefaultPolicy("v1-review-lkg")
        const variantId = await createVariant("Variant Review LKG")
        const exel = await createSupplier("exel_review_lkg", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-REVIEW-LKG")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 40, currencyCode: "mxn" } }, // caída extrema
        })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(123)
      })
    })

    describe("Etapa 5.1, §17 — auditoría de selección de fuente", () => {
      it("eventos PRICING_SOURCE_SELECTED, PRICING_SOURCE_CHANGED y PRICING_SOURCE_UNAVAILABLE con contexto completo", async () => {
        await createDefaultPolicy("v1-source-audit")
        const variantId = await createVariant("Variant Source Audit")
        const exel = await createSupplier("exel_source_audit", { isPrimary: true })
        const syscom = await createSupplier("syscom_source_audit")
        const mappingExel = await createMapping(exel.id, variantId, "SKU-EXEL-AUDIT")
        const mappingSyscom = await createMapping(syscom.id, variantId, "SKU-SYSCOM-AUDIT")

        const emitter = new InMemoryCommerceAuditEmitter()
        container().register({ [COMMERCE_AUDIT_EMITTER]: asValue(emitter) })

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        expect(emitter.events.some((e) => e.eventType === "PRICING_SOURCE_SELECTED")).toEqual(true)

        const supplierService = container().resolve<SupplierModuleService>(SUPPLIER_MODULE)
        await supplierService.updateSuppliers([
          { id: exel.id, is_primary_pricing_source: false },
          { id: syscom.id, is_primary_pricing_source: true },
        ])
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 90, currencyCode: "mxn" } },
        })
        const changed = emitter.events.find((e) => e.eventType === "PRICING_SOURCE_CHANGED")
        expect(changed).toBeTruthy()
        expect(changed!.details).toMatchObject({ before: exel.id, after: syscom.id })

        await supplierService.updateSuppliers([{ id: syscom.id, status: "inactive" }])
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 85, currencyCode: "mxn" } },
        })
        expect(emitter.events.some((e) => e.eventType === "PRICING_SOURCE_UNAVAILABLE")).toEqual(true)
      })
    })

    describe("Etapa 5.1, §26-§28 — Syscom ficticio y guardrails", () => {
      it("26. Syscom funciona como Supplier de datos puro, sin ningún SyscomAdapter ni integración real", async () => {
        await createDefaultPolicy("v1-syscom-plain")
        const variantId = await createVariant("Variant Syscom Plain")
        const syscom = await createSupplier("syscom_plain", { isPrimary: true })
        const mapping = await createMapping(syscom.id, variantId, "SKU-SYSCOM-PLAIN")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 90, currencyCode: "mxn" } },
        })
        expect(Number((await getMxnPrice(variantId))!.amount)).toEqual(110)
        // Ningún integrations/suppliers/syscom existe -- Syscom es 100%
        // datos de Supplier, probado arriba sin importar ningún adapter.
        expect(
          fs.existsSync(
            path.join(__dirname, "../../src/integrations/suppliers/syscom")
          )
        ).toEqual(false)
      })

      it("27. ningún archivo de pricing-rules contiene 'EXEL'/'SYSCOM' hardcodeado para la selección", () => {
        const workflowsDir = path.join(__dirname, "../../src/modules/pricing-rules")
        const files = [
          "rules/pricing-source-strategy.ts",
          "workflows/apply-supplier-pricing.ts",
        ]
        for (const file of files) {
          const content = fs.readFileSync(path.join(workflowsDir, file), "utf-8")
          expect(/===\s*["']exel/i.test(content)).toEqual(false)
          expect(/===\s*["']syscom/i.test(content)).toEqual(false)
        }
      })

      it("17 (Etapa 5). mismo costo repetido es idempotente -- no crea Prices duplicados", async () => {
        await createDefaultPolicy("v1-idempotent-5-1")
        const variantId = await createVariant("Variant Idempotent 5.1")
        const exel = await createSupplier("exel_idempotent_5_1", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-IDEMPOTENT-5-1")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const priceSetId = await getPriceSetIdForVariant(variantId)
        const pricingService = container().resolve(Modules.PRICING)
        const prices = await pricingService.listPrices({
          price_set_id: [priceSetId!],
          currency_code: ["mxn"],
        })
        expect(prices).toHaveLength(1)
      })

      it("28. aplicar precios no toca InventoryLevel", async () => {
        await createDefaultPolicy("v1-no-inventory")
        const variantId = await createVariant("Variant No Inventory 5.1")
        const exel = await createSupplier("exel_no_inventory_5_1", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-NO-INV-5-1")

        const link = container().resolve(ContainerRegistrationKeys.LINK)
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        const inventoryLinks = await link.list(
          { [Modules.PRODUCT]: { variant_id: variantId }, [Modules.INVENTORY]: { inventory_item_id: { $ne: null } } },
          {}
        )
        expect(inventoryLinks).toHaveLength(0)
      })
    })

    describe("Etapa 5 (preservado) — costo nunca se expone como precio público; tax-inclusive real", () => {
      it("el costo nunca se expone directamente como el Price público (123 != 100)", async () => {
        await createDefaultPolicy("v1-cost-not-public")
        const variantId = await createVariant("Variant Cost Not Public 5.1")
        const exel = await createSupplier("exel_cost_not_public_5_1", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-COST-NOT-PUBLIC-5-1")

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const price = await getMxnPrice(variantId)
        expect(Number(price!.amount)).toEqual(123)
        expect(Number(price!.amount)).not.toEqual(100)
      })

      it("is_calculated_price_tax_inclusive=true y el monto calculado es exactamente 123, no 142.68", async () => {
        await createDefaultPolicy("v1-tax-inclusive")
        const variantId = await createVariant("Variant Tax Inclusive 5.1")
        const exel = await createSupplier("exel_tax_inclusive_5_1", { isPrimary: true })
        const mapping = await createMapping(exel.id, variantId, "SKU-TAX-INCLUSIVE-5-1")

        const pricingService = container().resolve(Modules.PRICING)
        await pricingService.createPricePreferences({
          attribute: "currency_code",
          value: "mxn",
          is_tax_inclusive: true,
        })

        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mapping.id, cost: { amount: 100, currencyCode: "mxn" } },
        })

        const priceSetId = await getPriceSetIdForVariant(variantId)
        const [calculated] = await pricingService.calculatePrices(
          { id: [priceSetId!] },
          { context: { currency_code: "mxn" } }
        )
        expect(calculated.calculated_amount).toEqual(123)
        expect(calculated.is_calculated_price_tax_inclusive).toEqual(true)
        expect(calculated.calculated_amount).not.toEqual(142.68)
      })
    })

    describe("Etapa 5.1, §26 — escenario integrado real: Etapa 2 -> 3 -> 4 -> 5 -> 5.1", () => {
      it("Order feliz completo con selección de fuente: Exel primary gana sobre Syscom; costo inválido conserva 123 sin romper inventario", async () => {
        await createDefaultPolicy("v1-e2e-full")
        const exel = await createSupplier("exel_e2e_full", { isPrimary: true })
        const syscom = await createSupplier("syscom_e2e_full")
        const variantId = await createVariant("Variant E2E Full LAPTOP-001", "ABC123FULL")
        const mappingExel = await createMapping(exel.id, variantId, "ABC123FULL")
        const mappingSyscom = await createMapping(syscom.id, variantId, "SYSCOM-ABC123FULL")

        const classification = classifyConflicts(
          {
            supplierSku: "ABC123FULL",
            catalogTotal: 10,
            warehouseReadings: [
              { warehouseExternalCode: "MY", quantity: 4 },
              { warehouseExternalCode: "MX", quantity: 6 },
            ],
            knownWarehouseCodes: ["MY", "MX"],
          },
          { matchingMappingIds: [mappingExel.id], isDuplicateReferenceInSnapshot: false, upstreamError: false }
        )
        expect(classification.action).toEqual("APPLY")

        // Syscom también manda su propio costo, más barato -- no debe ganar.
        await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingSyscom.id, cost: { amount: 90, currencyCode: "mxn" } },
        })
        const { result: priceResult } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: 100, currencyCode: "mxn" } },
        })
        expect(priceResult).toMatchObject({ proceed: true, publicPriceAmount: 123, sourceSupplierId: exel.id })

        const price = await getMxnPrice(variantId)
        expect(Number(price!.amount)).toEqual(123)

        // Llega un costo inválido de EXEL (ej. error upstream real del
        // proveedor). NaN nunca se persiste como SupplierCost (BigNumber
        // no lo admite) -- EXEL conserva su último costo VÁLIDO (100), así
        // que la reselección reconfirma el mismo precio (123): no es un
        // rechazo clasificado, es una reafirmación segura que nunca llegó
        // a tocar el dato bueno que ya existía.
        const { result: reaffirmedResult } = await applySupplierPricingWorkflow(container()).run({
          input: { supplierProductMappingId: mappingExel.id, cost: { amount: NaN, currencyCode: "mxn" } },
        })
        expect(reaffirmedResult).toMatchObject({ proceed: true, publicPriceAmount: 123 })

        const priceAfter = await getMxnPrice(variantId)
        expect(Number(priceAfter!.amount)).toEqual(123)
      })
    })
  },
})
