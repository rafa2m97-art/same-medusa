import { normalizeDimensionsCm, normalizeWeightKg } from "./normalize-units"
import type { ConsolidatedParcel } from "./carrier-limits"

/**
 * Portado tal cual de `same_calculate_consolidated_parcel()` real
 * (SSH 2026-10-05, helpers.php) — aproximación volumétrica, NO un
 * bin-packing 3D real: una caja con el largo/ancho más grande de los
 * items y una altura derivada del volumen total restante, acotada por
 * un apilado máximo de 3x y por el límite de perímetro (girth).
 *
 * Constantes reales preservadas tal cual (no son de esta etapa):
 * MAX_SIDE=80cm, MAX_LENGTH=100cm, MAX_GIRTH=240cm, apilado máx. 3x.
 */

export interface ParcelUnit {
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
  quantity: number
}

const MAX_SIDE_CM = 80
const MAX_LENGTH_CM = 100
const MAX_GIRTH_CM = 240
const MAX_STACK_FACTOR = 3

export function consolidateParcel(units: ParcelUnit[]): ConsolidatedParcel {
  let totalWeightKg = 0
  let totalVolumeCm3 = 0
  let maxLengthCm = 0
  let maxWidthCm = 0
  let maxHeightCm = 0
  let totalHeightCm = 0

  for (const unit of units) {
    const qty = unit.quantity
    totalWeightKg += normalizeWeightKg(unit.weightKg) * qty

    const dims = normalizeDimensionsCm({ lengthCm: unit.lengthCm, widthCm: unit.widthCm, heightCm: unit.heightCm })
    totalVolumeCm3 += dims.lengthCm * dims.widthCm * dims.heightCm * qty

    maxLengthCm = Math.max(maxLengthCm, dims.lengthCm)
    maxWidthCm = Math.max(maxWidthCm, dims.widthCm)
    maxHeightCm = Math.max(maxHeightCm, dims.heightCm)
    totalHeightCm += dims.heightCm * qty
  }

  let lengthCm: number
  let widthCm: number
  let heightCm: number

  if (totalVolumeCm3 > 0) {
    lengthCm = Math.min(maxLengthCm, MAX_LENGTH_CM)
    widthCm = Math.min(maxWidthCm, MAX_SIDE_CM)

    const heightFromVolume = totalVolumeCm3 / (lengthCm * widthCm)
    const heightFromStack = Math.min(totalHeightCm, maxHeightCm * MAX_STACK_FACTOR)

    heightCm = Math.min(Math.max(heightFromVolume, maxHeightCm, 10), heightFromStack, MAX_SIDE_CM)

    const girthCm = lengthCm + 2 * (widthCm + heightCm)
    if (girthCm > MAX_GIRTH_CM) {
      heightCm = Math.max((MAX_GIRTH_CM - lengthCm - 2 * widthCm) / 2, 10)
    }
  } else {
    lengthCm = Math.max(maxLengthCm, 10)
    widthCm = Math.max(maxWidthCm, 10)
    heightCm = Math.max(maxHeightCm, 10)
  }

  return {
    weightKg: Math.round(totalWeightKg * 100) / 100,
    lengthCm: Math.min(Math.round(lengthCm * 100) / 100, MAX_LENGTH_CM),
    widthCm: Math.min(Math.round(widthCm * 100) / 100, MAX_SIDE_CM),
    heightCm: Math.min(Math.round(heightCm * 100) / 100, MAX_SIDE_CM),
  }
}
