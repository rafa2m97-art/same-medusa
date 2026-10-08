/**
 * Algoritmo de ruteo PURO (sin I/O) — la decisión "¿qué (proveedor,
 * almacén) surte cada línea de este carrito?" separada por completo de
 * la carga de datos (Supplier/SupplierWarehouse/InventoryLevel/
 * RoutingRule vive en workflows/run-cart-allocation.ts, nunca aquí).
 * Mismo patrón que `classifyConflicts` (Etapa 3), `planInventoryApply`
 * (Etapa 4) y `classifyPriceChange`/`PrimarySupplierStrategy` (Etapa
 * 5/5.1): poder probar cientos de combinaciones sin levantar DB.
 *
 * Generaliza, con evidencia real (SSH 2026-10-03,
 * `same_get_cart_fulfillment_allocations()` y sus helpers en
 * msl-exel-bridge/includes/helpers.php), el algoritmo HOY vigente en
 * producción — confirmado real, no inventado:
 *
 *   1. Single-origin-first: si (y solo si) está habilitado
 *      (`same_logistics_single_origin_enabled`, flag real que hoy por
 *      defecto está DESACTIVADO), se busca un único origen que cubra
 *      TODO el carrito. Un "preferred warehouse" configurado
 *      (`same_logistics_single_origin_preferred_warehouse`, real,
 *      default 'MX') SIEMPRE gana sobre el ranking si puede cubrir todo
 *      — es un override explícito, no una preferencia entre otras.
 *   2. Si no hay consolidación posible: split greedy por línea, cada
 *      línea rankeada independientemente.
 *   3. "Prefer whole-line-over-split" real: si UN candidato por sí solo
 *      cubre la cantidad completa de una línea, se usa ese — nunca se
 *      fragmenta una línea que un solo origen ya puede cubrir entera.
 *   4. All-or-nothing real: si CUALQUIER línea no se puede cubrir por
 *      completo (ni consolidado ni dividido), el carrito completo se
 *      considera UNFULFILLABLE — nunca se devuelve una asignación
 *      parcial de "lo que sí se pudo".
 *   5. Tie-break determinista real, en dos variantes confirmadas:
 *      - Single-origin: prioridad configurada asc -> distancia asc ->
 *        superávit total (stock total - requerido total) desc -> stock
 *        total desc -> código de almacén asc.
 *      - Por línea (split): prioridad configurada asc -> distancia asc
 *        -> stock disponible desc -> código de almacén asc.
 *      (El real usa `rank` 0/1/10 + `warehouse_code` como único
 *      desempate — aquí se separa en dos señales independientes,
 *      prioridad configurada y distancia, porque el usuario pidió
 *      explícitamente que la tabla configurada sea la autoridad cuando
 *      exista, y la distancia real (Haversine) sea el fallback cuando
 *      no — unificando los DOS mecanismos reales inconsistentes que
 *      hoy coexisten en producción: `class-msl-routing.php` (Haversine)
 *      y `helpers.php` (solo tabla estado->almacén, sin distancia).)
 *
 * Asunciones de input, responsabilidad del llamador (no de esta
 * función): una línea por `variantId` (sin duplicados), cantidades
 * enteras positivas, y cada `RoutingCandidate.configuredPriority`/
 * `distanceKm` ya resueltos (ver routing-rule-matching.ts/distance.ts).
 */

import { MedusaError } from "@medusajs/framework/utils"

export interface AllocationCartLine {
  variantId: string
  quantity: number
}

/**
 * Un origen posible para UNA variant concreta. La identidad real de un
 * "origen" es (supplierId, supplierWarehouseId) — nunca solo
 * `warehouseCode`, porque dos proveedores distintos podrían reutilizar
 * el mismo código de almacén (generalización multi-proveedor real: el
 * sistema actual solo tiene a Exel, por lo que nunca necesitó distinguir
 * esto).
 */
export interface RoutingCandidate {
  supplierId: string
  supplierWarehouseId: string
  /** Código legible (ej. "MY", "MTY-02") — solo para el desempate final determinista, nunca para identidad. */
  warehouseCode: string
  stockLocationId: string
  availableQuantity: number
  /** `null` = ningún RoutingRule configurado para este candidato en este destino. */
  configuredPriority: number | null
  /** `null` = no se pudo calcular (coordenadas faltantes en origen o destino). */
  distanceKm: number | null
}

export interface AllocateCartInput {
  lines: AllocationCartLine[]
  /** Candidatos disponibles, por variantId — una variant sin entrada aquí se trata como "sin candidatos". */
  candidatesByVariantId: Record<string, RoutingCandidate[]>
  /**
   * Generalización real de `same_logistics_single_origin_preferred_warehouse`
   * — el CÓDIGO de almacén preferido (no supplier+warehouse, para
   * preservar la semántica real exacta de "un código ganador sin
   * importar quién lo tenga"). `null`/`undefined` = sin preferencia
   * configurada.
   */
  preferredWarehouseCode?: string | null
  /** Generalización real de `same_logistics_single_origin_enabled` (default real: desactivado). */
  singleOriginEnabled: boolean
}

export interface AllocationAssignmentResult {
  supplierId: string
  supplierWarehouseId: string
  stockLocationId: string
  quantity: number
}

export interface AllocationLineResult {
  variantId: string
  requestedQuantity: number
  assignments: AllocationAssignmentResult[]
}

export interface AllocationShortage {
  variantId: string
  requestedQuantity: number
  /** Lo máximo que SÍ se hubiera podido cubrir para esta línea sola — solo para explicar el motivo, nunca se asigna de verdad (all-or-nothing). */
  maxFulfillableQuantity: number
}

export type AllocateCartResult =
  | {
      status: "FULFILLABLE"
      strategy: "SINGLE_ORIGIN" | "MULTI_ORIGIN"
      lines: AllocationLineResult[]
    }
  | {
      status: "UNFULFILLABLE"
      shortages: AllocationShortage[]
    }

function assertValidInput(input: AllocateCartInput): void {
  const seen = new Set<string>()
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `allocateCart: line quantity must be a positive integer (got ${line.quantity} for variant ${line.variantId})`
      )
    }
    if (seen.has(line.variantId)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `allocateCart: duplicate line for variant ${line.variantId} — merge lines before calling`
      )
    }
    seen.add(line.variantId)
  }
}

const UNRANKED = Number.POSITIVE_INFINITY

function candidateKey(candidate: Pick<RoutingCandidate, "supplierId" | "supplierWarehouseId">): string {
  return `${candidate.supplierId}::${candidate.supplierWarehouseId}`
}

function compareByConfiguredPriorityThenDistance(
  a: Pick<RoutingCandidate, "configuredPriority" | "distanceKm">,
  b: Pick<RoutingCandidate, "configuredPriority" | "distanceKm">
): number {
  const priorityA = a.configuredPriority ?? UNRANKED
  const priorityB = b.configuredPriority ?? UNRANKED
  if (priorityA !== priorityB) return priorityA - priorityB

  const distanceA = a.distanceKm ?? UNRANKED
  const distanceB = b.distanceKm ?? UNRANKED
  // Ambos UNRANKED (Infinity) producirían Infinity-Infinity=NaN, un
  // comparador inválido para Array.sort (rompe su garantía de orden —
  // causa real detectada por los tests de empate: con NaN, el resultado
  // dependía del orden de entrada en vez de ser determinista).
  if (distanceA === distanceB) return 0
  return distanceA - distanceB
}

interface SingleOriginCandidate {
  key: string
  sample: RoutingCandidate
  totalStock: number
  totalSurplus: number
}

function compareSingleOrigin(a: SingleOriginCandidate, b: SingleOriginCandidate): number {
  const rankDiff = compareByConfiguredPriorityThenDistance(a.sample, b.sample)
  if (rankDiff !== 0) return rankDiff
  if (a.totalSurplus !== b.totalSurplus) return b.totalSurplus - a.totalSurplus
  if (a.totalStock !== b.totalStock) return b.totalStock - a.totalStock
  return a.sample.warehouseCode.localeCompare(b.sample.warehouseCode)
}

function comparePerLine(a: RoutingCandidate, b: RoutingCandidate): number {
  const rankDiff = compareByConfiguredPriorityThenDistance(a, b)
  if (rankDiff !== 0) return rankDiff
  if (a.availableQuantity !== b.availableQuantity) return b.availableQuantity - a.availableQuantity
  return a.warehouseCode.localeCompare(b.warehouseCode)
}

/**
 * Único origen que cubra TODO el carrito, si existe y si
 * `singleOriginEnabled`. `null` = no aplica (cae a split multi-origen) —
 * nunca un resultado final por sí mismo.
 */
function trySingleOrigin(input: AllocateCartInput): AllocateCartResult | null {
  if (!input.singleOriginEnabled || input.lines.length === 0) return null

  const candidateListsByLine = input.lines.map(
    (line) => input.candidatesByVariantId[line.variantId] ?? []
  )

  const keysInFirstLine = new Set(candidateListsByLine[0]?.map(candidateKey) ?? [])
  const commonKeys = [...keysInFirstLine].filter((key) =>
    candidateListsByLine.every((candidates) => candidates.some((c) => candidateKey(c) === key))
  )
  if (commonKeys.length === 0) return null

  const covering: SingleOriginCandidate[] = []
  for (const key of commonKeys) {
    let coversEverything = true
    let totalStock = 0
    let totalRequired = 0
    let sample: RoutingCandidate | null = null

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]
      const candidate = candidateListsByLine[i].find((c) => candidateKey(c) === key)!
      sample = candidate
      totalStock += candidate.availableQuantity
      totalRequired += line.quantity
      if (candidate.availableQuantity < line.quantity) coversEverything = false
    }

    if (coversEverything && sample) {
      covering.push({ key, sample, totalStock, totalSurplus: totalStock - totalRequired })
    }
  }
  if (covering.length === 0) return null

  // Override real: un almacén preferido configurado que SÍ cubre todo
  // gana sin pasar por el ranking (same_logistics_single_origin_preferred_warehouse).
  const preferredMatch = input.preferredWarehouseCode
    ? covering.find((c) => c.sample.warehouseCode === input.preferredWarehouseCode)
    : undefined

  const chosen = preferredMatch ?? [...covering].sort(compareSingleOrigin)[0]

  const lines: AllocationLineResult[] = input.lines.map((line) => {
    const candidates = input.candidatesByVariantId[line.variantId] ?? []
    const candidate = candidates.find((c) => candidateKey(c) === chosen.key)!
    return {
      variantId: line.variantId,
      requestedQuantity: line.quantity,
      assignments: [
        {
          supplierId: candidate.supplierId,
          supplierWarehouseId: candidate.supplierWarehouseId,
          stockLocationId: candidate.stockLocationId,
          quantity: line.quantity,
        },
      ],
    }
  })

  return { status: "FULFILLABLE", strategy: "SINGLE_ORIGIN", lines }
}

/**
 * Split greedy independiente por línea, con prefer-whole-line-over-split
 * y all-or-nothing reales. Siempre evalúa TODAS las líneas (nunca
 * aborta en la primera que falla) para poder reportar `shortages`
 * completos — explainability pedida explícitamente — aunque el
 * resultado final, si hay cualquier shortage, sigue siendo
 * UNFULFILLABLE para el carrito completo (ninguna asignación parcial se
 * considera válida).
 */
function multiOriginSplit(input: AllocateCartInput): AllocateCartResult {
  const lines: AllocationLineResult[] = []
  const shortages: AllocationShortage[] = []

  for (const line of input.lines) {
    const candidates = input.candidatesByVariantId[line.variantId] ?? []
    const ranked = [...candidates].sort(comparePerLine)

    const wholeLineCandidate = ranked.find((c) => c.availableQuantity >= line.quantity)
    if (wholeLineCandidate) {
      lines.push({
        variantId: line.variantId,
        requestedQuantity: line.quantity,
        assignments: [
          {
            supplierId: wholeLineCandidate.supplierId,
            supplierWarehouseId: wholeLineCandidate.supplierWarehouseId,
            stockLocationId: wholeLineCandidate.stockLocationId,
            quantity: line.quantity,
          },
        ],
      })
      continue
    }

    let remaining = line.quantity
    const assignments: AllocationAssignmentResult[] = []
    for (const candidate of ranked) {
      if (remaining <= 0) break
      if (candidate.availableQuantity <= 0) continue
      const take = Math.min(remaining, candidate.availableQuantity)
      assignments.push({
        supplierId: candidate.supplierId,
        supplierWarehouseId: candidate.supplierWarehouseId,
        stockLocationId: candidate.stockLocationId,
        quantity: take,
      })
      remaining -= take
    }

    if (remaining > 0) {
      shortages.push({
        variantId: line.variantId,
        requestedQuantity: line.quantity,
        maxFulfillableQuantity: line.quantity - remaining,
      })
      continue
    }

    lines.push({ variantId: line.variantId, requestedQuantity: line.quantity, assignments })
  }

  if (shortages.length > 0) {
    return { status: "UNFULFILLABLE", shortages }
  }

  return { status: "FULFILLABLE", strategy: "MULTI_ORIGIN", lines }
}

export function allocateCart(input: AllocateCartInput): AllocateCartResult {
  assertValidInput(input)

  if (input.lines.length === 0) {
    return { status: "FULFILLABLE", strategy: "MULTI_ORIGIN", lines: [] }
  }

  const singleOriginResult = trySingleOrigin(input)
  if (singleOriginResult) return singleOriginResult

  return multiOriginSplit(input)
}
