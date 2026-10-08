import { model } from "@medusajs/framework/utils"

/**
 * El "PaymentReadiness" pedido explícitamente (plan §29): NUNCA un
 * booleano `ready=true` suelto -- un estado trazable y expirable que
 * responde "¿acabo de comprobar que esta allocation, estos precios,
 * estas reservas, este proveedor y este envío siguen siendo válidos
 * AHORA?" (principio final del plan).
 *
 * `status`:
 *   ready       -> todos los guards pasaron, autorizado para intentar
 *                  pago (Etapa 10, todavía no implementado aquí).
 *   not_ready   -> algún guard falló; `failure_code`/`failure_stage`
 *                  explican cuál y por qué (taxonomía, ver rules/taxonomy.ts).
 *   expired     -> era `ready` pero pasó `expires_at` sin consumirse.
 *   superseded  -> el carrito cambió y se generó un readiness nuevo;
 *                  este queda como historial, nunca se borra.
 *   consumed    -> (reservado para Etapa 10) se usó para iniciar pago real.
 *
 * `authorized_amount`/`currency_code` (plan §47): el monto EXACTO que
 * Payment (Etapa 10) deberá usar -- nunca recalculado en el momento de
 * cobrar. Si el total del Cart cambia después, este readiness queda
 * invalidado (nuevo fingerprint no coincide, ver rules/readiness-
 * fingerprint.ts) antes de que Payment pueda usarlo.
 *
 * `fingerprint` (plan §31): combina cart+allocation+precio+quote+
 * reservas+confirmación de proveedor -- cualquier cambio real en esos
 * insumos invalida el readiness vigente (plan §32).
 */
const CheckoutReadiness = model.define("checkout_readiness", {
  id: model.id().primaryKey(),
  cart_id: model.text(),
  status: model.enum(["ready", "not_ready", "expired", "superseded", "consumed"]).default("not_ready"),
  allocation_snapshot_id: model.text().nullable(),
  fingerprint: model.text(),
  authorized_amount: model.bigNumber().nullable(),
  currency_code: model.text().nullable(),
  shipping_quote_id: model.text().nullable(),
  supplier_confirmed_at: model.dateTime().nullable(),
  failure_code: model.text().nullable(),
  failure_stage: model.text().nullable(),
  failure_details: model.json().nullable(),
  retryable: model.boolean().nullable(),
  requires_reallocation: model.boolean().default(false),
  customer_action_required: model.boolean().default(false),
  expires_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["cart_id", "status"],
  },
])

export default CheckoutReadiness
