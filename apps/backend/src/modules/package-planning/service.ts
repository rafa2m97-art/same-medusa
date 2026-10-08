import { MedusaService } from "@medusajs/framework/utils"
import CarrierLimit from "./models/carrier-limit"
import PackagePlan from "./models/package-plan"
import Package from "./models/package"
import PackageItem from "./models/package-item"

class PackagePlanningModuleService extends MedusaService({
  CarrierLimit,
  PackagePlan,
  Package,
  PackageItem,
}) {}

export default PackagePlanningModuleService
