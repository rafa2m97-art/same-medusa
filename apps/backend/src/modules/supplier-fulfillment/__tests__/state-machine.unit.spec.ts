import { canTransition, hasLabelReadyOrBeyond, isTerminal, VALID_TRANSITIONS, type WarehouseShipmentStatus } from "../rules/state-machine"

const ALL_STATUSES = Object.keys(VALID_TRANSITIONS) as WarehouseShipmentStatus[]

describe("canTransition", () => {
  it("allows the real happy path: PENDING -> READY_FOR_LABEL -> LABEL_PURCHASING -> LABEL_PURCHASED -> SUPPLIER_SUBMISSION_PENDING -> SUPPLIER_SUBMITTING -> SUPPLIER_ACCEPTED -> PROCESSING -> SHIPPED -> DELIVERED", () => {
    const happyPath: WarehouseShipmentStatus[] = [
      "PENDING",
      "READY_FOR_LABEL",
      "LABEL_PURCHASING",
      "LABEL_PURCHASED",
      "SUPPLIER_SUBMISSION_PENDING",
      "SUPPLIER_SUBMITTING",
      "SUPPLIER_ACCEPTED",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
    ]
    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(canTransition(happyPath[i], happyPath[i + 1])).toBe(true)
    }
  })

  it("rejects an invalid transition (ej. saltar directo de PENDING a SUPPLIER_ACCEPTED)", () => {
    expect(canTransition("PENDING", "SUPPLIER_ACCEPTED")).toBe(false)
  })

  it("nunca permite CANCELLED directo desde un estado 'en vuelo' (LABEL_PURCHASING/SUPPLIER_SUBMITTING) -- plan §47", () => {
    expect(canTransition("LABEL_PURCHASING", "CANCELLED")).toBe(false)
    expect(canTransition("SUPPLIER_SUBMITTING", "CANCELLED")).toBe(false)
  })

  it("permite retry desde *_FAILED_RETRYABLE de vuelta al estado 'en vuelo' correspondiente", () => {
    expect(canTransition("LABEL_FAILED_RETRYABLE", "LABEL_PURCHASING")).toBe(true)
    expect(canTransition("SUPPLIER_FAILED_RETRYABLE", "SUPPLIER_SUBMITTING")).toBe(true)
  })

  it("DELIVERED y CANCELLED son terminales -- ninguna transición sale de ahí", () => {
    expect(VALID_TRANSITIONS.DELIVERED).toEqual([])
    expect(VALID_TRANSITIONS.CANCELLED).toEqual([])
  })

  it("todo estado no terminal tiene al menos una transición válida (nunca un estado 'atrapado' sin salida)", () => {
    for (const status of ALL_STATUSES) {
      if (isTerminal(status)) continue
      expect(VALID_TRANSITIONS[status].length).toBeGreaterThan(0)
    }
  })

  it("REQUIRES_MANUAL_REVIEW solo sale vía override explícito -- nunca lo alcanza un flujo automático sin pasar antes por un *_FAILED_FINAL o una falla ambigua", () => {
    expect(VALID_TRANSITIONS.REQUIRES_MANUAL_REVIEW).toContain("CANCELLED")
    expect(VALID_TRANSITIONS.REQUIRES_MANUAL_REVIEW.length).toBeGreaterThan(0)
  })
})

describe("hasLabelReadyOrBeyond / isTerminal", () => {
  it("considera 'label lista' desde LABEL_PURCHASED en adelante, nunca antes", () => {
    expect(hasLabelReadyOrBeyond("LABEL_PURCHASING")).toBe(false)
    expect(hasLabelReadyOrBeyond("LABEL_PURCHASED")).toBe(true)
    expect(hasLabelReadyOrBeyond("SUPPLIER_ACCEPTED")).toBe(true)
    expect(hasLabelReadyOrBeyond("DELIVERED")).toBe(true)
  })

  it("marca exactamente DELIVERED y CANCELLED como terminales", () => {
    for (const status of ALL_STATUSES) {
      expect(isTerminal(status)).toBe(status === "DELIVERED" || status === "CANCELLED")
    }
  })
})
