import { Module } from "@medusajs/framework/utils"
import CheckoutGuardsModuleService from "./service"

export const CHECKOUT_GUARDS_MODULE = "checkout_guards"

export default Module(CHECKOUT_GUARDS_MODULE, {
  service: CheckoutGuardsModuleService,
})
