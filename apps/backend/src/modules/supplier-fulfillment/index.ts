import { Module } from "@medusajs/framework/utils"
import SupplierFulfillmentModuleService from "./service"

export const SUPPLIER_FULFILLMENT_MODULE = "supplier_fulfillment"

export default Module(SUPPLIER_FULFILLMENT_MODULE, {
  service: SupplierFulfillmentModuleService,
})
