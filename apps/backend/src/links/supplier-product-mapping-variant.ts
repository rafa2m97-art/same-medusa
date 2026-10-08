import SupplierModule from "../modules/supplier"
import ProductModule from "@medusajs/medusa/product"
import { defineLink } from "@medusajs/framework/utils"

/**
 * 1 ProductVariant -> N SupplierProductMapping (uno por proveedor que la
 * vende). `isList: true` del lado de SupplierProductMapping es justo lo
 * que permite que, a futuro, una misma Variant se mapee a Proveedor A,
 * Proveedor B y Proveedor C sin tocar este archivo ni el modelo.
 *
 * Esto habilita la expansión vía el query graph de Medusa (ej.
 * `fields: "*supplier_product_mappings"` desde una variante en la Admin
 * API). La constraint única real (supplier_id, variant_id) vive en el
 * campo `variant_id` del modelo SupplierProductMapping, no en esta tabla
 * pivote — ver el comentario en models/supplier-product-mapping.ts.
 */
export default defineLink(ProductModule.linkable.productVariant, {
  linkable: SupplierModule.linkable.supplierProductMapping,
  isList: true,
})
