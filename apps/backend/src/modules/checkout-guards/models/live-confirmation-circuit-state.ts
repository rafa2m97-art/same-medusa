import { model } from "@medusajs/framework/utils"

/**
 * Estado persistido del circuit breaker de confirmación en vivo, UNO
 * por INTEGRACIÓN externa (plan Etapa 7 §19) -- generalización
 * multi-proveedor del mecanismo real de
 * `class-msl-exel-product-client.php`
 * (`msl_exel_inventory_api_failure`, un WordPress transient). Medusa no
 * tiene transients; una fila por `integration_key` con `opened_at`
 * cumple exactamente lo mismo: "¿cuándo fue la última falla?" + un TTL
 * (parámetro del workflow, nunca hardcodeado aquí) decide si sigue
 * abierto (ver rules/circuit-breaker.ts, puro).
 *
 * `integration_key` (renombrado en Etapa 8 desde `supplier_id`): este
 * mismo modelo se reutiliza para Envia (plan §41, "evalúa si Envia
 * necesita circuit breaker similar a supplier live confirmation... no
 * copiar sin pensar el mismo threshold de Exel") -- un `supplier_id`
 * real de proveedor es un caso particular de integración, nunca al
 * revés; `integration_key = "envia"` es el sentinel para la integración
 * de envío, igual de válido que un `Supplier.id` real para Exel/Syscom.
 *
 * Un éxito BORRA esta fila (igual que `delete_transient` real) -- por
 * eso no existe un campo `is_open`, la sola presencia de la fila (y su
 * antigüedad) es la señal.
 */
const LiveConfirmationCircuitState = model.define("live_confirmation_circuit_state", {
  id: model.id().primaryKey(),
  integration_key: model.text().unique(),
  opened_at: model.dateTime(),
  metadata: model.json().nullable(),
})

export default LiveConfirmationCircuitState
