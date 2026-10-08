import { MedusaService } from "@medusajs/framework/utils"
import Supplier from "./models/supplier"
import SupplierWarehouse from "./models/supplier-warehouse"
import SupplierProductMapping from "./models/supplier-product-mapping"
import SupplierProductState from "./models/supplier-product-state"
import SyncRun from "./models/sync-run"
import SyncConflict from "./models/sync-conflict"

class SupplierModuleService extends MedusaService({
  Supplier,
  SupplierWarehouse,
  SupplierProductMapping,
  SupplierProductState,
  SyncRun,
  SyncConflict,
}) {}

export default SupplierModuleService
