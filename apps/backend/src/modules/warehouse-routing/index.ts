import { Module } from "@medusajs/framework/utils"
import WarehouseRoutingModuleService from "./service"

export const WAREHOUSE_ROUTING_MODULE = "warehouse_routing"

export default Module(WAREHOUSE_ROUTING_MODULE, {
  service: WarehouseRoutingModuleService,
})
