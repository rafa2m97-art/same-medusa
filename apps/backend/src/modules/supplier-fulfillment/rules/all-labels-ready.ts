import { hasLabelReadyOrBeyond, type WarehouseShipmentStatus } from "./state-machine"

/**
 * Barrier real confirmado por SSH 2026-10-06 contra
 * class-msl-exel-api.php (bloque "Requerir guías de TODOS los
 * almacenes antes de mandar a Exel", `array_diff($expected_warehouses,
 * $received_warehouses)`): no se envía NADA al proveedor hasta que
 * TODOS los orígenes de la Order tengan guía -- nunca "el que ya esté
 * listo, que se mande".
 *
 * `CANCELLED` se excluye de "pendientes" a propósito: un origen
 * cancelado ya no participa del fulfillment, no debe bloquear a los
 * demás indefinidamente.
 */
export function allLabelsReady(shipmentStatuses: WarehouseShipmentStatus[]): boolean {
  const relevant = shipmentStatuses.filter((s) => s !== "CANCELLED")
  if (relevant.length === 0) return false
  return relevant.every((s) => hasLabelReadyOrBeyond(s))
}
