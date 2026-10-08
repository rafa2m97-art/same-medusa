/**
 * Tipos puros para los límites de transportista (ver models/carrier-
 * limit.ts para la procedencia/evidencia real completa). `evaluate*`
 * aquí son funciones puras de validación -- la persistencia/consulta
 * del catálogo real vive en el workflow, nunca aquí.
 */

export interface ParcelLimits {
  maxWeightKg: number
  maxLengthCm: number
  maxWidthCm: number
  maxHeightCm: number
  maxGirthCm: number
}

export interface ConsolidatedParcel {
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
}

export interface ParcelValidationResult {
  valid: boolean
  exceeded: string[]
  girthCm: number
}

/**
 * Portado tal cual de `same_validate_parcel()` real: perímetro
 * (girth) = largo + 2*(ancho + alto).
 */
export function validateParcel(parcel: ConsolidatedParcel, limits: ParcelLimits): ParcelValidationResult {
  const exceeded: string[] = []

  if (parcel.weightKg > limits.maxWeightKg) {
    exceeded.push(`peso (${parcel.weightKg}kg > ${limits.maxWeightKg}kg)`)
  }
  if (parcel.lengthCm > limits.maxLengthCm) {
    exceeded.push(`largo (${parcel.lengthCm}cm > ${limits.maxLengthCm}cm)`)
  }
  if (parcel.widthCm > limits.maxWidthCm) {
    exceeded.push(`ancho (${parcel.widthCm}cm > ${limits.maxWidthCm}cm)`)
  }
  if (parcel.heightCm > limits.maxHeightCm) {
    exceeded.push(`alto (${parcel.heightCm}cm > ${limits.maxHeightCm}cm)`)
  }

  const girthCm = parcel.lengthCm + 2 * (parcel.widthCm + parcel.heightCm)
  if (girthCm > limits.maxGirthCm) {
    exceeded.push(`perímetro (${girthCm}cm > ${limits.maxGirthCm}cm)`)
  }

  return { valid: exceeded.length === 0, exceeded, girthCm }
}

/**
 * ¿Hay AL MENOS un transportista conocido que acepte este paquete?
 * (plan §45) — una mejora deliberada sobre el real: producción solo
 * deja un `MSL_Utilities::log('warning', ...)` cuando un item individual
 * excede límites, y de todas formas EMPAQUETA el item (ver
 * same_split_items_into_parcels, bloque "WARNING: Item ... excede
 * límites individuales"). Aquí, si NINGÚN carrier conocido lo acepta,
 * el resultado es un estado explícito UNSHIPPABLE — nunca un log
 * silencioso con un paquete inválido de todas formas.
 */
export function isUnshippableForAnyCarrier(
  parcel: ConsolidatedParcel,
  allCarrierLimits: ParcelLimits[]
): boolean {
  if (allCarrierLimits.length === 0) return false
  return allCarrierLimits.every((limits) => !validateParcel(parcel, limits).valid)
}
