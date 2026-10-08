import { MedusaService } from "@medusajs/framework/utils"
import SupplierCost from "./models/supplier-cost"
import PricingPolicy from "./models/pricing-policy"
import PricingState from "./models/pricing-state"

class PricingRulesModuleService extends MedusaService({
  SupplierCost,
  PricingPolicy,
  PricingState,
}) {}

export default PricingRulesModuleService
