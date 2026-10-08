import { Module } from "@medusajs/framework/utils"
import PackagePlanningModuleService from "./service"

export const PACKAGE_PLANNING_MODULE = "package_planning"

export default Module(PACKAGE_PLANNING_MODULE, {
  service: PackagePlanningModuleService,
})
