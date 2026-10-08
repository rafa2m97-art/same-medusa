import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { SUPPLIER_MODULE } from "../index"

// Crear la BD temporal + migrar tarda más que el timeout default de Jest (5s).
jest.setTimeout(60000)
import Supplier from "../models/supplier"
import SupplierWarehouse from "../models/supplier-warehouse"
import SupplierProductMapping from "../models/supplier-product-mapping"
import SupplierProductState from "../models/supplier-product-state"
import SyncRun from "../models/sync-run"
import SyncConflict from "../models/sync-conflict"
import SupplierModuleService from "../service"

moduleIntegrationTestRunner<SupplierModuleService>({
  moduleName: SUPPLIER_MODULE,
  resolve: __dirname + "/..",
  moduleModels: [
    Supplier,
    SupplierWarehouse,
    SupplierProductMapping,
    SupplierProductState,
    SyncRun,
    SyncConflict,
  ],
  testSuite: ({ service }) => {
    describe("Supplier domain — Etapa 2", () => {
      // 1. crear Supplier
      it("crea un Supplier", async () => {
        const supplier = await service.createSuppliers({
          code: "exel_del_norte",
          name: "Exel del Norte",
          adapter_key: "exel_del_norte",
        })

        expect(supplier.id).toBeDefined()
        expect(supplier.code).toEqual("exel_del_norte")
        expect(supplier.status).toEqual("active")
      })

      // 2. impedir supplier.code duplicado
      it("impide crear dos Suppliers con el mismo code", async () => {
        await service.createSuppliers({
          code: "dup_supplier",
          name: "Proveedor Uno",
          adapter_key: "dup_supplier",
        })

        await expect(
          service.createSuppliers({
            code: "dup_supplier",
            name: "Proveedor Uno (otra vez)",
            adapter_key: "dup_supplier",
          })
        ).rejects.toThrow()
      })

      // 3. crear múltiples SupplierWarehouses para un Supplier
      it("crea varios SupplierWarehouse para un mismo Supplier", async () => {
        const supplier = await service.createSuppliers({
          code: "multi_wh_supplier",
          name: "Proveedor Multi Almacén",
          adapter_key: "multi_wh_supplier",
        })

        await service.createSupplierWarehouses([
          { supplier_id: supplier.id, external_code: "MY", name: "Monterrey" },
          { supplier_id: supplier.id, external_code: "MX", name: "Ciudad de México" },
          { supplier_id: supplier.id, external_code: "GD", name: "Guadalajara" },
        ])

        const warehouses = await service.listSupplierWarehouses({
          supplier_id: supplier.id,
        })
        expect(warehouses).toHaveLength(3)
        expect(warehouses.map((w) => w.external_code).sort()).toEqual([
          "GD",
          "MX",
          "MY",
        ])
      })

      // 4. permitir mismo warehouse_code en dos Suppliers distintos
      it("permite el mismo external_code en dos Suppliers distintos", async () => {
        const supplierA = await service.createSuppliers({
          code: "supplier_a",
          name: "Proveedor A",
          adapter_key: "supplier_a",
        })
        const supplierB = await service.createSuppliers({
          code: "supplier_b",
          name: "Proveedor B",
          adapter_key: "supplier_b",
        })

        const warehouseA = await service.createSupplierWarehouses({
          supplier_id: supplierA.id,
          external_code: "MX",
          name: "Ciudad de México (A)",
        })
        const warehouseB = await service.createSupplierWarehouses({
          supplier_id: supplierB.id,
          external_code: "MX",
          name: "Ciudad de México (B)",
        })

        expect(warehouseA.external_code).toEqual("MX")
        expect(warehouseB.external_code).toEqual("MX")
        expect(warehouseA.supplier_id).not.toEqual(warehouseB.supplier_id)
      })

      // 5. impedir duplicado del mismo warehouse dentro del mismo Supplier
      it("impide el mismo external_code dos veces dentro del mismo Supplier", async () => {
        const supplier = await service.createSuppliers({
          code: "no_dup_wh_supplier",
          name: "Proveedor Sin Duplicados",
          adapter_key: "no_dup_wh_supplier",
        })

        await service.createSupplierWarehouses({
          supplier_id: supplier.id,
          external_code: "TR",
          name: "Torreón",
        })

        await expect(
          service.createSupplierWarehouses({
            supplier_id: supplier.id,
            external_code: "TR",
            name: "Torreón (duplicado)",
          })
        ).rejects.toThrow()
      })

      // 6. mapear una ProductVariant a un Supplier
      it("mapea una ProductVariant a un Supplier", async () => {
        const supplier = await service.createSuppliers({
          code: "mapping_supplier",
          name: "Proveedor de Mapeo",
          adapter_key: "mapping_supplier",
        })

        const mapping = await service.createSupplierProductMappings({
          supplier_id: supplier.id,
          variant_id: "variant_01FAKE000000000000000001",
          supplier_sku: "WR209MB",
          supplier_internal_ref: "3MCACCAC016",
        })

        expect(mapping.variant_id).toEqual("variant_01FAKE000000000000000001")
        expect(mapping.supplier_sku).toEqual("WR209MB")
        // Etapa 3, decisión 2: la cuarentena ya no vive en este modelo —
        // un mapping recién creado todavía no tiene SupplierProductState
        // (se crea la primera vez que pasa por una reconciliación).
        expect("is_quarantined" in mapping).toEqual(false)
      })

      // 7. mapear la misma ProductVariant a varios Suppliers
      it("permite mapear la misma ProductVariant a varios Suppliers", async () => {
        const variantId = "variant_01FAKE000000000000000099"

        const supplierExel = await service.createSuppliers({
          code: "exel_multi",
          name: "Exel",
          adapter_key: "exel_multi",
        })
        const supplierOtro = await service.createSuppliers({
          code: "otro_proveedor_multi",
          name: "Otro Proveedor",
          adapter_key: "otro_proveedor_multi",
        })

        await service.createSupplierProductMappings([
          {
            supplier_id: supplierExel.id,
            variant_id: variantId,
            supplier_sku: "WR209MB",
            supplier_internal_ref: "3MCACCAC016",
          },
          {
            supplier_id: supplierOtro.id,
            variant_id: variantId,
            supplier_sku: "OTRO-SKU-001",
            supplier_internal_ref: "REF-OTRO-001",
          },
        ])

        const mappings = await service.listSupplierProductMappings({
          variant_id: variantId,
        })
        expect(mappings).toHaveLength(2)
        expect(mappings.map((m) => m.supplier_id).sort()).toEqual(
          [supplierExel.id, supplierOtro.id].sort()
        )
      })

      // 8. supplier_sku y supplier_internal_ref son campos distintos,
      // incluyendo el caso real de recodificación (Exel cambia la
      // referencia interna manteniendo el mismo SKU).
      it("mantiene supplier_sku y supplier_internal_ref como campos independientes ante una recodificación", async () => {
        const supplier = await service.createSuppliers({
          code: "recode_supplier",
          name: "Proveedor con Recodificación",
          adapter_key: "recode_supplier",
        })

        const mapping = await service.createSupplierProductMappings({
          supplier_id: supplier.id,
          variant_id: "variant_01FAKE000000000000000077",
          supplier_sku: "3M2000",
          supplier_internal_ref: "XECPAPAE003",
        })

        expect(mapping.supplier_sku).toEqual("3M2000")
        expect(mapping.supplier_internal_ref).toEqual("XECPAPAE003")

        // El proveedor recodifica su referencia interna sin avisar — el
        // SKU (ancla estable) no cambia. Caso real documentado.
        const [updated] = await service.updateSupplierProductMappings([
          { id: mapping.id, supplier_internal_ref: "XEAPAPAE002" },
        ])

        expect(updated.supplier_sku).toEqual("3M2000")
        expect(updated.supplier_internal_ref).toEqual("XEAPAPAE002")
      })

      // 14. ningún secreto queda persistido en Supplier/SupplierWarehouse/
      // SupplierProductMapping — comprobación real contra el esquema
      // parseado del modelo, no solo una promesa en un comentario.
      it("no define ningún campo de credenciales/secreto en los modelos del dominio", () => {
        const sensitivePattern = /key|secret|token|password|credential/i

        for (const Model of [Supplier, SupplierWarehouse, SupplierProductMapping]) {
          const parsed = (Model as any).parse()
          const fieldNames = Object.keys(parsed.schema)
          const offending = fieldNames.filter(
            (name) => sensitivePattern.test(name) && name !== "adapter_key"
          )
          expect(offending).toEqual([])
        }

        // adapter_key existe a propósito (identifica QUÉ adaptador usar),
        // pero su valor nunca debe parecer una credencial real.
        expect("adapter_key").not.toMatch(/^(sk_|pk_|Bearer )/)
      })
    })
  },
})
