import { model } from "@medusajs/framework/utils"

/**
 * La política de margen/impuesto/redondeo de SAME — NO del proveedor.
 *
 * Decisión explícita de Etapa 5 (plan §5): la fórmula real
 * `ceil((costo/0.95)*1.16)` representa un margen comercial que SAME
 * decide aplicar, no una peculiaridad técnica de la API de Exel — Exel
 * solo entrega el costo crudo (`precio`/`precio_actual` en
 * same_product_contract.py, confirmado por SSH 2026-10-03); el 5% y el
 * 16% viven en `same_product_contract.py`, un archivo COMPARTIDO del
 * pipeline (lo importan tanto `generar_precios_exel.py` como
 * `catalog_reconcile.py`), no en un archivo "Exel-específico" — evidencia
 * de que ya hoy es una política transversal de SAME, aunque hoy solo
 * tenga un proveedor. Por eso esta política vive en el dominio
 * (`pricing-rules/`), nunca en `integrations/suppliers/exel/` — un
 * `ExelPricingAdapter` que mañana tenga un ajuste propio de Exel seguiría
 * pudiendo existir, pero la regla comercial por defecto no depende de él.
 *
 * Nombres de campo (`margin_factor`/`tax_factor`) preservan EXACTAMENTE
 * la semántica real: `margin_factor=0.95` significa "el costo representa
 * el 95% del precio antes de impuesto" (no "margen del 5% sumado") — así
 * es como el sistema real siempre lo calculó; renombrarlo a algo como
 * `margin_rate=0.05` habría sido una reinterpretación, no una preservación.
 *
 * Versionado por INMUTABILIDAD: cambiar la política crea una fila NUEVA
 * (`code` nuevo, ej. "exel-default-v2") y marca la anterior `superseded`
 * — nunca se edita `margin_factor` de una fila existente. Así un precio
 * calculado meses atrás sigue siendo auditable contra la política EXACTA
 * que lo produjo (`PricingState.last_applied_policy_code`), y cambiar la
 * política no modifica precios históricos en silencio (pedido explícito,
 * plan §7/§18).
 *
 * `supplier_id` nullable = política POR DEFECTO (aplica a cualquier
 * proveedor sin una política propia) — campo plano, no relación MikroORM
 * (cross-módulo hacia `supplier`, mismo patrón que en otros lados).
 *
 * `min_change_ratio`/`max_change_ratio` (Etapa 5.1): la banda 0.5x-2.0x
 * que detecta cambios anómalos vivía como constante de código en Etapa 5
 * — el propio usuario señaló que es una protección NUEVA de SAME (no una
 * regla histórica comprobada, ver evidencia real en classify-price-change.ts)
 * y por eso NO debe quedar como "magic number": se versiona junto con el
 * resto de la política, para poder responder "qué versión de policy
 * clasificó este cambio" igual que ya se hace con margin_factor/tax_factor.
 */
const PricingPolicy = model.define("pricing_policy", {
  id: model.id().primaryKey(),
  code: model.text().unique(),
  supplier_id: model.text().nullable(),
  currency_code: model.text(),
  margin_factor: model.bigNumber(),
  tax_factor: model.bigNumber(),
  min_change_ratio: model.bigNumber(),
  max_change_ratio: model.bigNumber(),
  rounding_strategy: model.enum(["ceil_to_integer"]).default("ceil_to_integer"),
  status: model.enum(["active", "superseded"]).default("active"),
  effective_from: model.dateTime(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["supplier_id", "currency_code", "status"],
  },
])

export default PricingPolicy
