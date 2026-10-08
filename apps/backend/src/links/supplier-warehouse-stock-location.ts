import SupplierModule from "../modules/supplier"
import StockLocationModule from "@medusajs/medusa/stock-location"
import { defineLink } from "@medusajs/framework/utils"

/**
 * 1:1 — cada SupplierWarehouse corresponde a un StockLocation nativo (donde
 * vive el stock real vía InventoryLevel). El código de almacén del
 * proveedor (GD/MX/MY/TR...) NUNCA aparece aquí; esto solo asocia IDs.
 */
export default defineLink(
  SupplierModule.linkable.supplierWarehouse,
  StockLocationModule.linkable.stockLocation
)
