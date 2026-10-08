/**
 * Normalización de unidades (plan §9) — portado fielmente de la
 * evidencia real (SSH 2026-10-05,
 * `same_normalize_shipping_weight_value`/
 * `same_normalize_shipping_dimensions_values` en
 * msl-exel-bridge/includes/helpers.php). Unidades canónicas internas:
 * **kg** y **cm** (ver docblock de models/package.ts para por qué).
 *
 * Detección real confirmada (comentario textual del código real,
 * 2026-08-13): "los equipos reales mas pesados del catalogo (UPS
 * trifasicos, multifuncionales A3) rondan 100-300 kg y NO deben
 * dividirse; ningun producto real supera 1000 kg, asi que >1000 solo
 * puede ser gramos" — mismo umbral (1000) y mismo razonamiento se
 * preserva aquí tal cual, no es un número inventado para esta etapa.
 * Igual para dimensiones: umbral 300 (ningún producto real mide más de
 * 300cm por lado) para detectar milímetros.
 */

export function normalizeWeightKg(rawWeight: number): number {
  let weight = rawWeight

  if (weight > 1000) {
    // Un peso >1000 solo puede ser gramos mal etiquetados como kg.
    weight = weight / 1000
  }

  return Math.round(Math.max(0.1, weight) * 100) / 100
}

export interface RawDimensionsCm {
  lengthCm: number
  widthCm: number
  heightCm: number
}

export function normalizeDimensionsCm(raw: RawDimensionsCm): RawDimensionsCm {
  let { lengthCm, widthCm, heightCm } = raw

  if (Math.max(lengthCm, widthCm, heightCm) > 300) {
    // Ningún producto real mide más de 300cm por lado -- solo puede ser milímetros.
    lengthCm /= 10
    widthCm /= 10
    heightCm /= 10
  }

  return {
    lengthCm: Math.max(1, lengthCm),
    widthCm: Math.max(1, widthCm),
    heightCm: Math.max(1, heightCm),
  }
}
