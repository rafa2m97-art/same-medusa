import { allocateCart, type AllocateCartInput, type RoutingCandidate } from "../rules/allocate-cart"

function candidate(overrides: Partial<RoutingCandidate> & { supplierWarehouseId: string }): RoutingCandidate {
  return {
    supplierId: "sup_exel",
    warehouseCode: overrides.supplierWarehouseId,
    stockLocationId: `stock_loc_${overrides.supplierWarehouseId}`,
    availableQuantity: 0,
    configuredPriority: null,
    distanceKm: null,
    ...overrides,
  }
}

describe("allocateCart — single-origin-first", () => {
  it("consolidates the whole cart into one origin when it covers everything", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [
        { variantId: "v1", quantity: 2 },
        { variantId: "v2", quantity: 1 },
      ],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MY", availableQuantity: 5 })],
        v2: [candidate({ supplierWarehouseId: "MY", availableQuantity: 5 })],
      },
    }
    const result = allocateCart(input)
    expect(result.status).toBe("FULFILLABLE")
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.strategy).toBe("SINGLE_ORIGIN")
    expect(result.lines).toHaveLength(2)
    for (const line of result.lines) {
      expect(line.assignments).toHaveLength(1)
      expect(line.assignments[0].supplierWarehouseId).toBe("MY")
    }
  })

  it("does not attempt consolidation when singleOriginEnabled is false, even if one origin could cover everything", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 2 }],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MY", availableQuantity: 5 })],
      },
    }
    const result = allocateCart(input)
    expect(result.status).toBe("FULFILLABLE")
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.strategy).toBe("MULTI_ORIGIN")
  })

  it("breaks ties among covering origins by configuredPriority ascending", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [{ variantId: "v1", quantity: 1 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MX", availableQuantity: 5, configuredPriority: 1 }),
          candidate({ supplierWarehouseId: "MY", availableQuantity: 5, configuredPriority: 0 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MY")
  })

  it("falls back to distanceKm ascending when configuredPriority ties", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [{ variantId: "v1", quantity: 1 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MX", availableQuantity: 5, configuredPriority: null, distanceKm: 800 }),
          candidate({ supplierWarehouseId: "MY", availableQuantity: 5, configuredPriority: null, distanceKm: 120 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MY")
  })

  it("falls back to total surplus descending when priority and distance tie", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [{ variantId: "v1", quantity: 2 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MX", availableQuantity: 3 }), // surplus 1
          candidate({ supplierWarehouseId: "MY", availableQuantity: 10 }), // surplus 8
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MY")
  })

  it("cascades through a fully-tied surplus/stock (required is constant across the whole cart, so they tie together) down to warehouseCode ascending", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [
        { variantId: "v1", quantity: 1 },
        { variantId: "v2", quantity: 1 },
      ],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MX", availableQuantity: 1 }),
          candidate({ supplierWarehouseId: "MY", availableQuantity: 3 }),
        ],
        v2: [
          candidate({ supplierWarehouseId: "MX", availableQuantity: 3 }),
          candidate({ supplierWarehouseId: "MY", availableQuantity: 1 }),
        ],
      },
    }
    // MX totals: stock 4, surplus 2. MY totals: stock 4, surplus 2. Fully tied -> warehouseCode asc decides.
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MX")
  })

  it("breaks a fully-tied ranking by warehouseCode ascending", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [{ variantId: "v1", quantity: 1 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "TR", availableQuantity: 5 }),
          candidate({ supplierWarehouseId: "GD", availableQuantity: 5 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("GD")
  })

  it("lets a configured preferred warehouse override the ranking entirely", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      preferredWarehouseCode: "MX",
      lines: [{ variantId: "v1", quantity: 1 }],
      candidatesByVariantId: {
        v1: [
          // MY would win on pure ranking (lower configuredPriority) — MX must still be chosen.
          candidate({ supplierWarehouseId: "MY", availableQuantity: 5, configuredPriority: 0 }),
          candidate({ supplierWarehouseId: "MX", availableQuantity: 5, configuredPriority: 5 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MX")
  })

  it("falls back to normal ranking when the preferred warehouse cannot cover everything", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      preferredWarehouseCode: "MX",
      lines: [{ variantId: "v1", quantity: 5 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MX", availableQuantity: 2 }), // cannot cover -> not a covering candidate
          candidate({ supplierWarehouseId: "MY", availableQuantity: 5, configuredPriority: 0 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MY")
  })

  it("falls through to multi-origin split when no single origin is common to every line", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [
        { variantId: "v1", quantity: 1 },
        { variantId: "v2", quantity: 1 },
      ],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MX", availableQuantity: 5 })],
        v2: [candidate({ supplierWarehouseId: "MY", availableQuantity: 5 })],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.strategy).toBe("MULTI_ORIGIN")
  })

  it("falls through to multi-origin split when the common origin cannot cover every line's full quantity", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [
        { variantId: "v1", quantity: 1 },
        { variantId: "v2", quantity: 10 },
      ],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MX", availableQuantity: 5 })],
        v2: [candidate({ supplierWarehouseId: "MX", availableQuantity: 2 })],
      },
    }
    const result = allocateCart(input)
    // v2 cannot be fulfilled by MX alone, and it's the only candidate for v2 -> UNFULFILLABLE overall.
    expect(result.status).toBe("UNFULFILLABLE")
  })

  it("handles a single-line cart (degenerate case)", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: true,
      lines: [{ variantId: "v1", quantity: 3 }],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MY", availableQuantity: 3 })],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.strategy).toBe("SINGLE_ORIGIN")
  })
})

describe("allocateCart — multi-origin split", () => {
  it("prefers a single whole-line origin over splitting even when a higher-priority partial candidate exists", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 5 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MY", availableQuantity: 2, configuredPriority: 0 }),
          candidate({ supplierWarehouseId: "MX", availableQuantity: 5, configuredPriority: 1 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments).toHaveLength(1)
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("MX")
  })

  it("splits a line across two origins when no single one covers it, filling the top-ranked first", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 7 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "MY", availableQuantity: 4, configuredPriority: 0 }),
          candidate({ supplierWarehouseId: "MX", availableQuantity: 5, configuredPriority: 1 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments).toEqual([
      expect.objectContaining({ supplierWarehouseId: "MY", quantity: 4 }),
      expect.objectContaining({ supplierWarehouseId: "MX", quantity: 3 }),
    ])
  })

  it("splits a line across three or more origins when necessary", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 9 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "GD", availableQuantity: 3, configuredPriority: 0 }),
          candidate({ supplierWarehouseId: "MY", availableQuantity: 3, configuredPriority: 1 }),
          candidate({ supplierWarehouseId: "MX", availableQuantity: 3, configuredPriority: 2 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments).toHaveLength(3)
    expect(result.lines[0].assignments.reduce((sum, a) => sum + a.quantity, 0)).toBe(9)
  })

  it("returns UNFULFILLABLE for the whole cart when any single line cannot be fully covered (all-or-nothing)", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [
        { variantId: "v1", quantity: 2 },
        { variantId: "v2", quantity: 100 },
      ],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MY", availableQuantity: 5 })],
        v2: [candidate({ supplierWarehouseId: "MY", availableQuantity: 1 })],
      },
    }
    const result = allocateCart(input)
    expect(result.status).toBe("UNFULFILLABLE")
    if (result.status !== "UNFULFILLABLE") throw new Error("unreachable")
    expect(result.shortages).toEqual([
      { variantId: "v2", requestedQuantity: 100, maxFulfillableQuantity: 1 },
    ])
  })

  it("reports shortages for every unfulfillable line, not just the first one found", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [
        { variantId: "v1", quantity: 10 },
        { variantId: "v2", quantity: 20 },
      ],
      candidatesByVariantId: {
        v1: [candidate({ supplierWarehouseId: "MY", availableQuantity: 3 })],
        v2: [candidate({ supplierWarehouseId: "MY", availableQuantity: 5 })],
      },
    }
    const result = allocateCart(input)
    expect(result.status).toBe("UNFULFILLABLE")
    if (result.status !== "UNFULFILLABLE") throw new Error("unreachable")
    expect(result.shortages).toEqual([
      { variantId: "v1", requestedQuantity: 10, maxFulfillableQuantity: 3 },
      { variantId: "v2", requestedQuantity: 20, maxFulfillableQuantity: 5 },
    ])
  })

  it("reports a shortage with maxFulfillableQuantity 0 when a variant has no candidates at all", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 1 }],
      candidatesByVariantId: {},
    }
    const result = allocateCart(input)
    expect(result.status).toBe("UNFULFILLABLE")
    if (result.status !== "UNFULFILLABLE") throw new Error("unreachable")
    expect(result.shortages).toEqual([{ variantId: "v1", requestedQuantity: 1, maxFulfillableQuantity: 0 }])
  })

  it("skips candidates with zero available quantity when greedily splitting (none alone covers the line)", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 5 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "GD", availableQuantity: 0, configuredPriority: 0 }),
          candidate({ supplierWarehouseId: "MY", availableQuantity: 2, configuredPriority: 1 }),
          candidate({ supplierWarehouseId: "MX", availableQuantity: 3, configuredPriority: 2 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments).toEqual([
      expect.objectContaining({ supplierWarehouseId: "MY", quantity: 2 }),
      expect.objectContaining({ supplierWarehouseId: "MX", quantity: 3 }),
    ])
  })

  it("returns FULFILLABLE with an empty line list for an empty cart", () => {
    const result = allocateCart({ singleOriginEnabled: true, lines: [], candidatesByVariantId: {} })
    expect(result).toEqual({ status: "FULFILLABLE", strategy: "MULTI_ORIGIN", lines: [] })
  })

  it("breaks per-line ties by configuredPriority, then distance, then stock, then warehouseCode", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 1 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierWarehouseId: "TR", availableQuantity: 5 }),
          candidate({ supplierWarehouseId: "GD", availableQuantity: 5 }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments[0].supplierWarehouseId).toBe("GD")
  })

  it("supports multiple suppliers (EXEL + fictitious SYSCOM) competing for the same line without any supplier-specific branching", () => {
    const input: AllocateCartInput = {
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 6 }],
      candidatesByVariantId: {
        v1: [
          candidate({ supplierId: "sup_exel", supplierWarehouseId: "MY", availableQuantity: 3, configuredPriority: 0 }),
          candidate({
            supplierId: "sup_syscom",
            supplierWarehouseId: "MTY",
            availableQuantity: 5,
            configuredPriority: 1,
          }),
        ],
      },
    }
    const result = allocateCart(input)
    if (result.status !== "FULFILLABLE") throw new Error("unreachable")
    expect(result.lines[0].assignments).toEqual([
      expect.objectContaining({ supplierId: "sup_exel", supplierWarehouseId: "MY", quantity: 3 }),
      expect.objectContaining({ supplierId: "sup_syscom", supplierWarehouseId: "MTY", quantity: 3 }),
    ])
  })

  it("is deterministic regardless of the input candidate array order", () => {
    const candidatesInOrderA: RoutingCandidate[] = [
      candidate({ supplierWarehouseId: "MY", availableQuantity: 4, configuredPriority: 0 }),
      candidate({ supplierWarehouseId: "MX", availableQuantity: 5, configuredPriority: 1 }),
    ]
    const candidatesInOrderB = [...candidatesInOrderA].reverse()

    const resultA = allocateCart({
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 7 }],
      candidatesByVariantId: { v1: candidatesInOrderA },
    })
    const resultB = allocateCart({
      singleOriginEnabled: false,
      lines: [{ variantId: "v1", quantity: 7 }],
      candidatesByVariantId: { v1: candidatesInOrderB },
    })
    expect(resultA).toEqual(resultB)
  })
})

describe("allocateCart — input validation", () => {
  it("throws for a zero or negative quantity", () => {
    expect(() =>
      allocateCart({
        singleOriginEnabled: false,
        lines: [{ variantId: "v1", quantity: 0 }],
        candidatesByVariantId: {},
      })
    ).toThrow(/positive integer/)
  })

  it("throws for a non-integer quantity", () => {
    expect(() =>
      allocateCart({
        singleOriginEnabled: false,
        lines: [{ variantId: "v1", quantity: 1.5 }],
        candidatesByVariantId: {},
      })
    ).toThrow(/positive integer/)
  })

  it("throws for a duplicate variantId across lines", () => {
    expect(() =>
      allocateCart({
        singleOriginEnabled: false,
        lines: [
          { variantId: "v1", quantity: 1 },
          { variantId: "v1", quantity: 2 },
        ],
        candidatesByVariantId: {},
      })
    ).toThrow(/duplicate line/)
  })
})
