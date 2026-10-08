/**
 * Haversine — fórmula REAL confirmada por SSH 2026-10-03 en
 * `class-msl-routing.php::calculate_distance()` (radio terrestre 6371km,
 * cálculo estándar de círculo máximo). Esa misma función existe hoy en
 * producción pero vive en un mecanismo de ruteo PARALELO e inconsistente
 * con el más autoritativo (`same_get_cart_fulfillment_allocations()` en
 * helpers.php, que usa solo una tabla estado->almacén sin distancia
 * real). Etapa 6 unifica ambos: la tabla configurada
 * (`RoutingRule`/routing-rule-matching.ts) es la fuente de verdad cuando
 * existe una fila para ese candidato+destino; esta función es el
 * FALLBACK cuando no existe ninguna — nunca al revés.
 */

export interface GeoPoint {
  latitude: number
  longitude: number
}

const EARTH_RADIUS_KM = 6371

export function haversineDistanceKm(from: GeoPoint, to: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180

  const deltaLatitude = toRadians(to.latitude - from.latitude)
  const deltaLongitude = toRadians(to.longitude - from.longitude)
  const fromLatitudeRadians = toRadians(from.latitude)
  const toLatitudeRadians = toRadians(to.latitude)

  const sinHalfDeltaLat = Math.sin(deltaLatitude / 2)
  const sinHalfDeltaLon = Math.sin(deltaLongitude / 2)

  const centralAngleSquared =
    sinHalfDeltaLat * sinHalfDeltaLat +
    Math.cos(fromLatitudeRadians) * Math.cos(toLatitudeRadians) * sinHalfDeltaLon * sinHalfDeltaLon

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(centralAngleSquared)))
}
