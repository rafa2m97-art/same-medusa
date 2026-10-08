import { MedusaService } from "@medusajs/framework/utils"
import WarehouseShipment from "./models/warehouse-shipment"
import WarehouseShipmentEvent from "./models/warehouse-shipment-event"

class SupplierFulfillmentModuleService extends MedusaService({
  WarehouseShipment,
  WarehouseShipmentEvent,
}) {}

export default SupplierFulfillmentModuleService
