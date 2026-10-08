import { planPackages, type PlanPackagesLine } from "../rules/plan-packages"
import type { ParcelLimits } from "../rules/carrier-limits"

const DEFAULT_LIMITS: ParcelLimits = {
  maxWeightKg: 30,
  maxLengthCm: 120,
  maxWidthCm: 80,
  maxHeightCm: 80,
  maxGirthCm: 300,
}

function line(overrides: Partial<PlanPackagesLine> & { variantId: string }): PlanPackagesLine {
  return {
    allocationAssignmentId: `aa_${overrides.variantId}`,
    quantity: 1,
    weightKg: 1,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    ...overrides,
  }
}

function totalItemQuantity(result: ReturnType<typeof planPackages>): number {
  if (result.status !== "PLANNED") return 0
  return result.packages.reduce((sum, p) => sum + p.items.reduce((s, i) => s + i.quantity, 0), 0)
}

describe("planPackages — caso simple", () => {
  it("un origin con items pequeños produce un solo paquete", () => {
    const result = planPackages({
      lines: [line({ variantId: "A", quantity: 2 }), line({ variantId: "B", quantity: 1 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    expect(result.packages).toHaveLength(1)
    expect(result.packages[0].status).toBe("planned")
  })

  it("conserva la cantidad total exacta, nunca pierde ni duplica unidades", () => {
    const result = planPackages({
      lines: [line({ variantId: "A", quantity: 5 }), line({ variantId: "B", quantity: 3 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(totalItemQuantity(result)).toBe(8)
  })

  it("no duplica items: cada unidad aparece en exactamente un paquete", () => {
    const result = planPackages({
      lines: [line({ variantId: "A", quantity: 10, weightKg: 5, lengthCm: 40, widthCm: 40, heightCm: 40 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    const totalAcrossPackages = result.packages.reduce(
      (sum, p) => sum + p.items.filter((i) => i.variantId === "A").reduce((s, i) => s + i.quantity, 0),
      0
    )
    expect(totalAcrossPackages).toBe(10)
  })
})

describe("planPackages — datos físicos faltantes (plan §44, Opción A: bloquear)", () => {
  it("retorna MISSING_PHYSICAL_DATA cuando falta el peso de cualquier línea", () => {
    const result = planPackages({
      lines: [line({ variantId: "A", weightKg: null })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result).toEqual({ status: "MISSING_PHYSICAL_DATA", missingVariantIds: ["A"] })
  })

  it("retorna MISSING_PHYSICAL_DATA cuando falta cualquier dimensión", () => {
    const result = planPackages({
      lines: [line({ variantId: "A", lengthCm: null })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("MISSING_PHYSICAL_DATA")
  })

  it("nunca usa un fallback silencioso (0.5kg/10x10x10) como el sistema real -- lista explícitamente las variants afectadas", () => {
    const result = planPackages({
      lines: [line({ variantId: "A", weightKg: null }), line({ variantId: "B" }), line({ variantId: "C", heightCm: null })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result).toEqual({ status: "MISSING_PHYSICAL_DATA", missingVariantIds: ["A", "C"] })
  })
})

describe("planPackages — múltiples unidades de la misma línea pueden dividirse", () => {
  it("divide 3 monitores grandes en paquetes separados cuando no caben juntos", () => {
    // 3 x 12kg = 36kg > maxWeightKg(30) -- no pueden ir juntos en un solo paquete.
    const result = planPackages({
      lines: [line({ variantId: "Monitor", quantity: 3, weightKg: 12, lengthCm: 70, widthCm: 60, heightCm: 15 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    expect(result.packages.length).toBeGreaterThan(1)
    expect(totalItemQuantity(result)).toBe(3)
  })

  it("mantiene 1 solo paquete cuando varias unidades pequeñas sí caben juntas", () => {
    const result = planPackages({
      lines: [line({ variantId: "SmallItem", quantity: 5, weightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    expect(result.packages).toHaveLength(1)
  })
})

describe("planPackages — límites respetados", () => {
  it("respeta max_weight: ningún paquete planned excede el límite de peso", () => {
    const result = planPackages({
      lines: [line({ variantId: "Heavy", quantity: 4, weightKg: 12, lengthCm: 20, widthCm: 20, heightCm: 20 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    for (const pkg of result.packages.filter((p) => p.status === "planned")) {
      expect(pkg.parcel.weightKg).toBeLessThanOrEqual(DEFAULT_LIMITS.maxWeightKg)
    }
  })

  it("respeta max_dimensions: ningún paquete planned excede largo/ancho/alto", () => {
    const result = planPackages({
      lines: [line({ variantId: "Big", quantity: 3, weightKg: 1, lengthCm: 70, widthCm: 60, heightCm: 50 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    for (const pkg of result.packages.filter((p) => p.status === "planned")) {
      expect(pkg.parcel.lengthCm).toBeLessThanOrEqual(DEFAULT_LIMITS.maxLengthCm)
      expect(pkg.parcel.widthCm).toBeLessThanOrEqual(DEFAULT_LIMITS.maxWidthCm)
      expect(pkg.parcel.heightCm).toBeLessThanOrEqual(DEFAULT_LIMITS.maxHeightCm)
    }
  })
})

describe("planPackages — producto force-own-package / unshippable individual (plan §45)", () => {
  it("marca unshippable explícito un paquete cuya única unidad excede los límites por sí sola", () => {
    const result = planPackages({
      lines: [line({ variantId: "TooHeavy", weightKg: 999, lengthCm: 999, widthCm: 999, heightCm: 999 })],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    expect(result.packages).toHaveLength(1)
    expect(result.packages[0].status).toBe("unshippable")
    expect(result.packages[0].unshippableReason).toMatch(/Excede límites/)
  })

  it("un item unshippable no bloquea el resto del plan -- los demás paquetes siguen 'planned'", () => {
    const result = planPackages({
      lines: [
        line({ variantId: "TooHeavy", weightKg: 999, lengthCm: 999, widthCm: 999, heightCm: 999 }),
        line({ variantId: "Normal", weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }),
      ],
      defaultLimits: DEFAULT_LIMITS,
    })
    expect(result.status).toBe("PLANNED")
    if (result.status !== "PLANNED") throw new Error("unreachable")
    expect(result.packages.some((p) => p.status === "unshippable")).toBe(true)
    expect(result.packages.some((p) => p.status === "planned")).toBe(true)
    expect(totalItemQuantity(result)).toBe(2)
  })
})

describe("planPackages — determinismo", () => {
  it("el mismo input siempre produce el mismo plan (same input -> same packages)", () => {
    const input = {
      lines: [
        line({ variantId: "A", quantity: 3, weightKg: 4, lengthCm: 30, widthCm: 25, heightCm: 20 }),
        line({ variantId: "B", quantity: 2, weightKg: 6, lengthCm: 40, widthCm: 30, heightCm: 25 }),
      ],
      defaultLimits: DEFAULT_LIMITS,
    }
    expect(planPackages(input)).toEqual(planPackages(input))
  })
})

describe("planPackages — validación de input", () => {
  it("lanza un error para cantidad cero o negativa", () => {
    expect(() => planPackages({ lines: [line({ variantId: "A", quantity: 0 })], defaultLimits: DEFAULT_LIMITS })).toThrow(
      /positive integer/
    )
  })

  it("retorna PLANNED vacío para un plan sin líneas", () => {
    expect(planPackages({ lines: [], defaultLimits: DEFAULT_LIMITS })).toEqual({ status: "PLANNED", packages: [] })
  })
})
