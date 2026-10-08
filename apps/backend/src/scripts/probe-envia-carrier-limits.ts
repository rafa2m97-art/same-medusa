/**
 * Descubrimiento empírico CONTROLADO de límites reales de Envia (plan
 * Etapa 8 §16) — SOLO sandbox, SOLO cotización (`/ship/rate/`, sin
 * crear guía). No hace "cientos de llamadas irresponsables": prueba un
 * único peso/dimensión creciente por carrier, se detiene en el primer
 * rechazo, y reporta el último punto que SÍ cotizó -- exactamente el
 * mismo método con el que se verificaron empíricamente DHL y
 * Paquetexpress en producción (ver carrier-limits-seed.ts).
 *
 * Uso:
 *   ENVIA_API_KEY=xxx ENVIA_PROBE_CONFIRM=yes npx medusa exec ./src/scripts/probe-envia-carrier-limits.ts
 *
 * Seguridad (plan §16/§36/§37):
 *   - Requiere `ENVIA_PROBE_CONFIRM=yes` explícito -- nunca corre por
 *     accidente desde un cron/CI.
 *   - Requiere `ENVIA_BASE_URL` apuntando a sandbox explícitamente, o
 *     se niega a correr contra el host de producción por defecto.
 *   - Nunca llama ningún endpoint de compra de guía -- EnviaAdapter ni
 *     siquiera expone ese método (ver envia-adapter.ts).
 *   - La API key se lee de variable de entorno, nunca se imprime en
 *     logs/output.
 */
import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { EnviaAdapter } from "../integrations/fulfillment/envia/envia-adapter"
import type { ShippingRateRequest } from "../modules/package-planning/types"

const PRODUCTION_HOST = "api.envia.com"

const PROBE_WEIGHTS_KG = [10, 30, 70, 100, 150, 200, 266, 300, 350, 500]

function buildProbeRequest(carrierCode: string, weightKg: number): ShippingRateRequest {
  return {
    origin: {
      name: "SAME TEST",
      phone: "8117986338",
      street: "Av. Test",
      number: "100",
      district: "Centro",
      city: "San Nicolás de los Garza",
      state: "NLE",
      country: "MX",
      postalCode: "66422",
    },
    destination: {
      name: "Cliente Test",
      phone: "8117986338",
      street: "Av. Test Destino",
      number: "200",
      district: "Centro",
      city: "Guadalajara",
      state: "JAL",
      country: "MX",
      postalCode: "44940",
    },
    packages: [{ weightKg, lengthCm: 100, widthCm: 80, heightCm: 60, declaredValue: 100 }],
    carrierCodes: [carrierCode],
    currencyCode: "mxn",
  }
}

export default async function probeEnviaCarrierLimits({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const apiKey = process.env.ENVIA_API_KEY
  const baseUrl = process.env.ENVIA_BASE_URL
  const confirmed = process.env.ENVIA_PROBE_CONFIRM === "yes"

  if (!confirmed) {
    logger.error(
      "Abortado: falta ENVIA_PROBE_CONFIRM=yes. Este script hace llamadas reales de cotización a Envia -- requiere confirmación explícita (plan §16)."
    )
    return
  }
  if (!apiKey) {
    logger.error("Abortado: falta ENVIA_API_KEY en el entorno.")
    return
  }
  if (!baseUrl || baseUrl.includes(PRODUCTION_HOST)) {
    logger.error(
      "Abortado: ENVIA_BASE_URL debe apuntar explícitamente a un host de sandbox -- nunca se corre contra producción por defecto (plan §16/§36)."
    )
    return
  }

  const adapter = new EnviaAdapter({ apiKey, baseUrl })
  const carriers = ["fedex", "dhl", "estafeta", "redpack", "paquetexpress", "ups", "99minutos", "ampm"]

  for (const carrier of carriers) {
    let lastSuccessfulWeight: number | null = null
    for (const weightKg of PROBE_WEIGHTS_KG) {
      const result = await adapter.getRates(buildProbeRequest(carrier, weightKg))
      if (result.success && result.rates.length > 0) {
        lastSuccessfulWeight = weightKg
        continue
      }
      logger.info(
        `[probe] ${carrier}: rechazado/sin tarifa en ${weightKg}kg -- último exitoso: ${lastSuccessfulWeight ?? "ninguno"}kg`
      )
      break
    }
    if (lastSuccessfulWeight === PROBE_WEIGHTS_KG[PROBE_WEIGHTS_KG.length - 1]) {
      logger.info(`[probe] ${carrier}: cotizó sin rechazo hasta el techo probado (${lastSuccessfulWeight}kg) -- probar más alto antes de asumir que alcanza.`)
    }
  }

  logger.info(
    "Resultados informativos solamente -- actualizar carrier-limits-seed.ts manualmente con fecha/ruta/nota real tras revisar, nunca automáticamente."
  )
}
