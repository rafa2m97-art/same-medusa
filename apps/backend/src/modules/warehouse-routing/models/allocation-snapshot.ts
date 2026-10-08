import { model } from "@medusajs/framework/utils"
import AllocationLine from "./allocation-line"

/**
 * La decisión de ruteo CONGELADA para un carrito, en un momento dado —
 * el equivalente, para Routing, de `SyncRun` (Etapa 3) o `PricingState`
 * (Etapa 5): responde "¿qué se decidió, con qué datos, y sigue
 * vigente?"
 *
 * Ciclo de vida explícito (plan Etapa 6, §TTL/lifecycle):
 *   DRAFT       -> se calculó pero todavía no se confirmó contra nada vivo
 *   ACTIVE      -> es la allocation vigente que gobierna el carrito ahora
 *   EXPIRED     -> venció su `expires_at` sin usarse (job de limpieza)
 *   SUPERSEDED  -> el carrito cambió (línea/cantidad/destino) y se
 *                  recalculó; esta queda como historial, nunca se borra
 *   CONSUMED    -> el carrito se completó usando esta allocation (futuro,
 *                  checkout — Etapa 6 NO implementa este consumo real,
 *                  solo reserva el valor del enum)
 *   INVALIDATED -> se descartó por una razón externa (ej. stock cambió
 *                  tras `confirmAllocationLive`, Etapa 7) antes de usarse
 *
 * Solo DEBE existir una fila en estado ACTIVE por `cart_id` a la vez —
 * invariante que garantiza el workflow (run-cart-allocation.ts:
 * supersede-then-create, mismo patrón que
 * create-pricing-policy-version.ts), nunca una unique index a nivel de
 * BD (el estado cambia con el tiempo, una unique constraint sobre
 * status tendría que ser parcial y Medusa DML no la expresa hoy).
 *
 * `input_fingerprint` (ver rules/fingerprint.ts) detecta si el carrito
 * REALMENTE cambió desde la última allocation calculada — si un
 * recalculo produce el mismo fingerprint que la ACTIVE vigente, el
 * workflow reutiliza esa fila en vez de crear una nueva idéntica
 * (idempotencia, pedido explícito).
 *
 * `destination` se guarda inline (JSON pequeño: estado/ciudad/CP/lat/
 * lng) — no justifica una tabla propia, es un snapshot de 5 campos que
 * nunca se consulta de forma relacional por sí solo.
 *
 * `routing_policy_version` es trazabilidad (qué conjunto de
 * RoutingRule/flags gobernó esta decisión) — mismo principio que
 * `PricingState.last_applied_policy_code` en Etapa 5: un cambio de
 * reglas futuro no debe volver ambiguas las decisiones ya tomadas.
 */
const AllocationSnapshot = model.define("allocation_snapshot", {
  id: model.id().primaryKey(),
  cart_id: model.text(),
  status: model
    .enum(["draft", "active", "expired", "superseded", "consumed", "invalidated"])
    .default("draft"),
  strategy: model.enum(["single_origin", "multi_origin", "unfulfillable"]).nullable(),
  destination: model.json().nullable(),
  input_fingerprint: model.text(),
  routing_policy_version: model.text(),
  expires_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
  lines: model.hasMany(() => AllocationLine, { mappedBy: "allocation_snapshot" }),
}).indexes([
  {
    on: ["cart_id", "status"],
  },
])

export default AllocationSnapshot
