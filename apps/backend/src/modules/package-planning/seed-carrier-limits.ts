import { PACKAGE_PLANNING_MODULE } from "./index"
import type PackagePlanningModuleService from "./service"
import { REAL_CARRIER_LIMITS_SEED } from "./carrier-limits-seed"

/**
 * Siembra el catálogo real de límites (ver carrier-limits-seed.ts) la
 * primera vez que el módulo corre -- idempotente (nunca duplica filas
 * ya sembradas, identificadas por `carrier_code`). No es un Workflow
 * de Medusa a propósito: es una operación de bootstrap de datos de
 * referencia, no una transacción de negocio que necesite compensación.
 */
export async function seedCarrierLimits(container: { resolve: (key: string) => unknown }): Promise<void> {
  const packagePlanningService = container.resolve(PACKAGE_PLANNING_MODULE) as PackagePlanningModuleService

  const existing = await packagePlanningService.listCarrierLimits({})
  const existingCarrierCodes = new Set(existing.map((row) => row.carrier_code))

  const toCreate = REAL_CARRIER_LIMITS_SEED.filter((row) => !existingCarrierCodes.has(row.carrierCode))
  if (toCreate.length === 0) return

  await packagePlanningService.createCarrierLimits(
    toCreate.map((row) => ({
      carrier_code: row.carrierCode,
      service_code: row.serviceCode,
      max_weight_kg: row.maxWeightKg,
      max_length_cm: row.maxLengthCm,
      max_width_cm: row.maxWidthCm,
      max_height_cm: row.maxHeightCm,
      max_girth_cm: row.maxGirthCm,
      source: row.source,
      verified_at: row.verifiedAt ? new Date(row.verifiedAt) : null,
      environment: row.environment,
      notes: row.notes,
    }))
  )
}
