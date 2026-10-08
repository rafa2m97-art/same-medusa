/**
 * Circuit breaker genérico, por proveedor (plan §19) — generalización
 * multi-proveedor del mecanismo REAL confirmado por SSH 2026-10-03 en
 * `class-msl-exel-product-client.php`:
 *
 *   - UNA sola falla abre el circuito (no N consecutivas -- eso es un
 *     mecanismo DISTINTO, el de `sync_to_wc_fast.py`, usado para el
 *     cron de catálogo, no para la confirmación en vivo de checkout).
 *   - TTL real: `FAILURE_TTL = 300` segundos, pero YA configurable en
 *     producción vía `apply_filters('msl_exel_failure_cache_ttl', ...)`
 *     -- aquí se preserva igual: parámetro explícito, nunca una
 *     constante hardcodeada sin forma de cambiarla (plan §19: "no
 *     hardcodear 300 si puede evitarse").
 *   - Un éxito cierra el circuito inmediatamente
 *     (`delete_transient`) -- no hay "medio abierto" gradual.
 *
 * Puro: recibe el último fallo conocido (o null) y decide. La
 * persistencia de ese dato (una fila por `supplier_id`, nunca un
 * transient de WordPress) vive en el workflow.
 */

export interface CircuitBreakerState {
  lastFailureAt: Date | null
}

export interface CircuitBreakerOptions {
  cooldownMs: number
  now: Date
}

export interface CircuitBreakerDecision {
  open: boolean
}

export function evaluateCircuitBreaker(
  state: CircuitBreakerState,
  options: CircuitBreakerOptions
): CircuitBreakerDecision {
  if (!state.lastFailureAt) {
    return { open: false }
  }
  const elapsedMs = options.now.getTime() - state.lastFailureAt.getTime()
  return { open: elapsedMs < options.cooldownMs }
}
