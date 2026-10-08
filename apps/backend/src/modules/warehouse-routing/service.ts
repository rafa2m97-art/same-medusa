import { MedusaService } from "@medusajs/framework/utils"
import RoutingRule from "./models/routing-rule"
import AllocationSnapshot from "./models/allocation-snapshot"
import AllocationLine from "./models/allocation-line"
import AllocationAssignment from "./models/allocation-assignment"

class WarehouseRoutingModuleService extends MedusaService({
  RoutingRule,
  AllocationSnapshot,
  AllocationLine,
  AllocationAssignment,
}) {}

export default WarehouseRoutingModuleService
