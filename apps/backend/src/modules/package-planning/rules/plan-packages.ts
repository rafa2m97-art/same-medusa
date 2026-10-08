import { MedusaError } from "@medusajs/framework/utils"
import { consolidateParcel, type ParcelUnit } from "./consolidate-parcel"
import { validateParcel, type ConsolidatedParcel, type ParcelLimits } from "./carrier-limits"

/**
 * Algoritmo de empaque PURO (plan §11) — generaliza, con evidencia real
 * (SSH 2026-10-05, `same_split_items_into_parcels()` en helpers.php),
 * el bin-packing greedy YA vigente en producción:
 *
 *   1. descomponer cada línea por cantidad en unidades individuales
 *      (plan §13: "3 monitores pueden volverse 3 paquetes separados");
 *   2. ordenar unidades por VOLUMEN descendente (items grandes primero
 *      -- mismo criterio real, `usort` por volumen);
 *   3. first-fit greedy: intentar agregar cada unidad al paquete
 *      ACTUAL; si el parcel consolidado sigue dentro de los límites,
 *      se queda; si no, cerrar el paquete actual y abrir uno nuevo con
 *      esa unidad.
 *
 * Mejora deliberada sobre el real (plan §44/§45): nunca un fallback
 * silencioso a peso/dimensiones falsas (el real usa `?: 0.5`/`?: 10` --
 * ver evidencia en same_convert_routing_to_packages) -- si falta
 * CUALQUIER dato físico de CUALQUIER línea, el resultado es
 * MISSING_PHYSICAL_DATA explícito (Opción A del plan §44: bloquear).
 * Y si una sola unidad excede los límites por sí misma, el paquete que
 * la contiene queda marcado `unshippable` explícito -- el real solo
 * deja un log de warning y empaqueta igual (ver bloque "WARNING: Item
 * ... excede límites individuales").
 */

export interface PlanPackagesLine {
  variantId: string
  allocationAssignmentId: string
  quantity: number
  weightKg: number | null
  lengthCm: number | null
  widthCm: number | null
  heightCm: number | null
}

export interface PlanPackagesInput {
  lines: PlanPackagesLine[]
  defaultLimits: ParcelLimits
}

export interface PlannedPackageItem {
  variantId: string
  allocationAssignmentId: string
  quantity: number
}

export interface PlannedPackage {
  status: "planned" | "unshippable"
  unshippableReason: string | null
  parcel: ConsolidatedParcel
  items: PlannedPackageItem[]
}

export type PlanPackagesResult =
  | { status: "PLANNED"; packages: PlannedPackage[] }
  | { status: "MISSING_PHYSICAL_DATA"; missingVariantIds: string[] }

interface Unit {
  variantId: string
  allocationAssignmentId: string
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
}

function toParcelUnit(unit: Unit): ParcelUnit {
  return { weightKg: unit.weightKg, lengthCm: unit.lengthCm, widthCm: unit.widthCm, heightCm: unit.heightCm, quantity: 1 }
}

function aggregateItems(units: Unit[]): PlannedPackageItem[] {
  const byKey = new Map<string, PlannedPackageItem>()
  for (const unit of units) {
    const key = `${unit.allocationAssignmentId}::${unit.variantId}`
    const existing = byKey.get(key)
    if (existing) {
      existing.quantity += 1
    } else {
      byKey.set(key, { variantId: unit.variantId, allocationAssignmentId: unit.allocationAssignmentId, quantity: 1 })
    }
  }
  return [...byKey.values()]
}

export function planPackages(input: PlanPackagesInput): PlanPackagesResult {
  if (input.lines.length === 0) {
    return { status: "PLANNED", packages: [] }
  }

  const missingVariantIds = input.lines
    .filter((l) => l.weightKg === null || l.lengthCm === null || l.widthCm === null || l.heightCm === null)
    .map((l) => l.variantId)
  if (missingVariantIds.length > 0) {
    return { status: "MISSING_PHYSICAL_DATA", missingVariantIds }
  }

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `planPackages: line quantity must be a positive integer (got ${line.quantity} for variant ${line.variantId})`
      )
    }
  }

  const units: Unit[] = []
  for (const line of input.lines) {
    for (let i = 0; i < line.quantity; i++) {
      units.push({
        variantId: line.variantId,
        allocationAssignmentId: line.allocationAssignmentId,
        weightKg: line.weightKg as number,
        lengthCm: line.lengthCm as number,
        widthCm: line.widthCm as number,
        heightCm: line.heightCm as number,
      })
    }
  }

  units.sort((a, b) => {
    const volA = a.lengthCm * a.widthCm * a.heightCm
    const volB = b.lengthCm * b.widthCm * b.heightCm
    return volB - volA
  })

  const packages: PlannedPackage[] = []
  let current: Unit[] = []

  const closeCurrent = () => {
    if (current.length === 0) return
    const parcel = consolidateParcel(current.map(toParcelUnit))
    const validation = validateParcel(parcel, input.defaultLimits)
    packages.push({
      status: validation.valid ? "planned" : "unshippable",
      unshippableReason: validation.valid ? null : `Excede límites: ${validation.exceeded.join(", ")}`,
      parcel,
      items: aggregateItems(current),
    })
    current = []
  }

  for (const unit of units) {
    const testUnits = [...current, unit]
    const testParcel = consolidateParcel(testUnits.map(toParcelUnit))
    const validation = validateParcel(testParcel, input.defaultLimits)

    if (validation.valid) {
      current.push(unit)
      continue
    }

    // No cabe en el paquete actual -- cerrarlo y empezar uno nuevo con esta unidad.
    closeCurrent()
    current = [unit]

    const singleParcel = consolidateParcel([toParcelUnit(unit)])
    const singleValidation = validateParcel(singleParcel, input.defaultLimits)
    if (!singleValidation.valid) {
      // Esta única unidad ya excede límites por sí sola -- el paquete
      // que la contenga queda marcado unshippable explícito (plan §45),
      // nunca un log de warning silencioso que empaqueta igual.
      closeCurrent()
    }
  }
  closeCurrent()

  return { status: "PLANNED", packages }
}
