import { Module } from "@medusajs/framework/utils"
import PricingRulesModuleService from "./service"

export const PRICING_RULES_MODULE = "pricing_rules"

export default Module(PRICING_RULES_MODULE, {
  service: PricingRulesModuleService,
})
