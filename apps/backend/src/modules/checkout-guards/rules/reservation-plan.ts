/**
 * Idempotencia de reservas (plan §9/§10/§11) — decide, de forma pura,
 * qué crear/actualizar/reutilizar/liberar contra el ReservationItem
 * NATIVO de Medusa, para que correr la preparación de checkout dos
 * veces para la MISMA allocation deje `reserved=2`, nunca `reserved=4`.
 *
 * Identidad estable de "reservation intent" (plan §11): la tripleta
 * (line_item_id, location_id, inventory_item_id) -- `line_item_id` es
 * el LineItem REAL del Cart (no un id sintético), así que
 * `deleteReservationsByLineItemsWorkflow` nativo de Medusa puede
 * liberar todo lo de un checkout abandonado sin lógica propia (plan
 * §33). Una sola línea de carrito puede tener VARIAS reservas (una por
 * AllocationAssignment, Etapa 6) cuando Routing dividió esa línea entre
 * varios almacenes -- por eso la identidad nunca es solo
 * `line_item_id`.
 *
 * `toRelease`: reservas existentes de estas MISMAS líneas que ya NO
 * corresponden a la allocation actual (ej. Routing cambió de almacén
 * tras un re-cálculo) -- deben liberarse, nunca quedar huérfanas
 * reservando stock que ya no es parte de la decisión vigente.
 */

export interface DesiredReservation {
  lineItemId: string
  inventoryItemId: string
  locationId: string
  quantity: number
}

export interface ExistingReservation {
  id: string
  lineItemId: string
  inventoryItemId: string
  locationId: string
  quantity: number
}

export interface ReservationPlan {
  toCreate: DesiredReservation[]
  toUpdate: Array<{ id: string; quantity: number }>
  toReuse: string[]
  toRelease: string[]
}

function reservationKey(r: { lineItemId: string; inventoryItemId: string; locationId: string }): string {
  return `${r.lineItemId}::${r.inventoryItemId}::${r.locationId}`
}

export function planReservations(
  desired: DesiredReservation[],
  existing: ExistingReservation[]
): ReservationPlan {
  const existingByKey = new Map(existing.map((r) => [reservationKey(r), r]))
  const matchedExistingIds = new Set<string>()

  const toCreate: DesiredReservation[] = []
  const toUpdate: Array<{ id: string; quantity: number }> = []
  const toReuse: string[] = []

  for (const want of desired) {
    const match = existingByKey.get(reservationKey(want))
    if (!match) {
      toCreate.push(want)
      continue
    }
    matchedExistingIds.add(match.id)
    if (match.quantity === want.quantity) {
      toReuse.push(match.id)
    } else {
      toUpdate.push({ id: match.id, quantity: want.quantity })
    }
  }

  const toRelease = existing.filter((r) => !matchedExistingIds.has(r.id)).map((r) => r.id)

  return { toCreate, toUpdate, toReuse, toRelease }
}
