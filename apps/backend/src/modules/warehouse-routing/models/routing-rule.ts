import { model } from "@medusajs/framework/utils"

/**
 * Preferencia CONFIGURADA de origen por destino — la generalización
 * multi-proveedor de la tabla real hoy hardcodeada en
 * `same_get_allocation_proximity_rank()` (helpers.php, verificado por
 * SSH 2026-10-03): NL->MY, JAL->GD, COAH->TR, CDMX->MX. Esa tabla real
 * vive hardcodeada en código PHP y asume un único proveedor (Exel) —
 * aquí es DATA editable, nunca una constante, y cada fila ya apunta a un
 * (supplier_id, supplier_warehouse_id) concreto, no solo a un código de
 * almacén global.
 *
 * `priority` es el rank EXPLÍCITO (menor = más preferido) para un
 * destino dado, cuando existen varias filas para el mismo
 * destination_state (ej. "1. EXEL-MY, 2. SYSCOM-MTY"). Un candidato sin
 * ninguna fila que lo mencione para ese destino no tiene prioridad
 * configurada — el algoritmo (allocate-cart.ts) cae a distancia
 * (haversine) para esos casos, nunca a un valor inventado (ver
 * rules/routing-rule-matching.ts).
 *
 * `destination_state` normalizado a mayúsculas (ej. "NL", "CDMX") — el
 * mismo nivel de granularidad que usa hoy el sistema real; no se inventa
 * un nivel más fino (CP/ciudad) sin evidencia de que el negocio lo
 * necesite.
 *
 * `supplier_id`/`supplier_warehouse_id` son campos PLANOS (no relaciones
 * MikroORM) — viven en el módulo `supplier`, mismo patrón que en
 * `pricing-rules` y el resto de este proyecto: ningún módulo tiene FK
 * real hacia otro módulo.
 */
const RoutingRule = model.define("routing_rule", {
  id: model.id().primaryKey(),
  destination_state: model.text(),
  supplier_id: model.text(),
  supplier_warehouse_id: model.text(),
  priority: model.number(),
  status: model.enum(["active", "inactive"]).default("active"),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["destination_state", "supplier_id", "supplier_warehouse_id"],
    unique: true,
  },
  {
    on: ["destination_state", "status"],
  },
])

export default RoutingRule
