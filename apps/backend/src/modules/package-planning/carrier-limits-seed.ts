/**
 * Catálogo real de límites por transportista (plan §15) — portado
 * CASI verbatim de `same_get_carrier_limits()` (SSH 2026-10-05,
 * msl-exel-bridge/includes/helpers.php). No es una semilla inventada:
 * cada fila documentada aquí tiene la misma procedencia/fecha/nota que
 * el código real que la originó. Usado para poblar `CarrierLimit` la
 * primera vez que el módulo corre (ver workflows/seed-carrier-limits.ts).
 *
 * `default` (sin carrier_code específico) es la política CONSERVADORA
 * que `planPackages()` usa para decidir cuándo dividir — nunca un
 * límite de carrier real (ver docblock de models/carrier-limit.ts).
 */

export interface CarrierLimitSeedRow {
  carrierCode: string
  serviceCode: string | null
  maxWeightKg: number
  maxLengthCm: number
  maxWidthCm: number
  maxHeightCm: number
  maxGirthCm: number
  source: "documented" | "empirically_verified"
  verifiedAt: string | null
  environment: "sandbox" | "production" | null
  notes: string | null
}

export const REAL_CARRIER_LIMITS_SEED: CarrierLimitSeedRow[] = [
  {
    carrierCode: "default",
    serviceCode: null,
    maxWeightKg: 30.0,
    maxLengthCm: 120,
    maxWidthCm: 80,
    maxHeightCm: 80,
    maxGirthCm: 300,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "Límites conservadores por defecto -- usados por planPackages() para decidir cuándo dividir, nunca límites reales de un carrier.",
  },
  {
    carrierCode: "fedex",
    serviceCode: null,
    maxWeightKg: 68.0,
    maxLengthCm: 274,
    maxWidthCm: 274,
    maxHeightCm: 274,
    maxGirthCm: 330,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "FedEx Express/International/Priority/Overnight. Girth fórmula especial FedEx: 2*ancho+2*alto+largo <= 330cm.",
  },
  {
    carrierCode: "dhl",
    serviceCode: null,
    maxWeightKg: 500.0,
    maxLengthCm: 150,
    maxWidthCm: 150,
    maxHeightCm: 100,
    maxGirthCm: 650,
    source: "empirically_verified",
    verifiedAt: "2026-08-28",
    environment: "production",
    notes:
      "Servicio ground/doméstico vía Envia.com (no DHL Express internacional). Verificado EN VIVO contra producción de Envia.com (POST /ship/rate/ real, sin crear guía) que DHL cotiza sin rechazo paquetes de 126.55/150/200/266/300/350/500kg con dimensiones hasta 100x100x80cm, ruta San Nicolás de los Garza NL -> Guadalajara JAL. El límite documentado anterior (70kg/80cm ancho) excluía productos reales del catálogo (ej. UPS APC Slot 8000VA, 126.55kg). Sin probar techo real por encima de 500kg.",
  },
  {
    carrierCode: "estafeta",
    serviceCode: null,
    maxWeightKg: 70.0,
    maxLengthCm: 150,
    maxWidthCm: 115,
    maxHeightCm: 115,
    maxGirthCm: 500,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "Estafeta Standard/Next day/Terrestre/Two days. Sin límite explícito de girth en la documentación pública.",
  },
  {
    carrierCode: "redpack",
    serviceCode: null,
    maxWeightKg: 10.0,
    maxLengthCm: 40,
    maxWidthCm: 40,
    maxHeightCm: 40,
    maxGirthCm: 200,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "Redpack Ecoexpress/Express -- límites muy restrictivos para servicios express.",
  },
  {
    carrierCode: "99minutos",
    serviceCode: null,
    maxWeightKg: 20.0,
    maxLengthCm: 50,
    maxWidthCm: 50,
    maxHeightCm: 50,
    maxGirthCm: 250,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "99minutos -- todos los servicios.",
  },
  {
    carrierCode: "paquetexpress",
    serviceCode: null,
    maxWeightKg: 300.0,
    maxLengthCm: 150,
    maxWidthCm: 150,
    maxHeightCm: 100,
    maxGirthCm: 650,
    source: "empirically_verified",
    verifiedAt: "2026-08-28",
    environment: "production",
    notes:
      "Servicio Nacional/estándar (catálogo público: hasta 70kg). Verificado EN VIVO contra producción de Envia.com, 2a pasada (tras arreglar la colonia de origen faltante), que Paquetexpress cotiza sin rechazo 126.55/150/200/266/300kg con dimensiones hasta 100x80x60cm, y resulta ~6-7x más barato que DHL en la misma ruta (San Nicolás de los Garza NL -> Guadalajara JAL). Sin probar techo real por encima de 300kg.",
  },
  {
    carrierCode: "ups",
    serviceCode: null,
    maxWeightKg: 70.0,
    maxLengthCm: 120,
    maxWidthCm: 120,
    maxHeightCm: 120,
    maxGirthCm: 400,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "UPS Express Saver/Expedited. Contorno especial UPS.",
  },
  {
    carrierCode: "ampm",
    serviceCode: null,
    maxWeightKg: 35.0,
    maxLengthCm: 120,
    maxWidthCm: 60,
    maxHeightCm: 120,
    maxGirthCm: 360,
    source: "documented",
    verifiedAt: null,
    environment: null,
    notes: "AMPM Standard.",
  },
]
