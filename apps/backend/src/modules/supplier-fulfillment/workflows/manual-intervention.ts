import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { SUPPLIER_FULFILLMENT_MODULE } from "../index"
import type SupplierFulfillmentModuleService from "../service"
import { isTerminal, type WarehouseShipmentStatus } from "../rules/state-machine"
import { assertValidTransition, emitEvent } from "./shared"

/**
 * Operaciones de dominio EXPLÍCITAS para intervención manual (plan Etapa
 * 9 §16-§23) -- deliberadamente NO un `updateWarehouseShipment(...)`
 * genérico que acepte cualquier status. Cada operación aquí:
 *
 *   - valida la transición contra VALID_TRANSITIONS (nunca un UPDATE
 *     silencioso de `status`);
 *   - exige `actor`/`reason` (nunca una operación manual anónima/sin
 *     motivo);
 *   - produce un evento auditado con estado previo/nuevo (plan §23);
 *   - nunca reintenta un side effect externo cuyo resultado sea
 *     AMBIGUO -- esos casos exigen `attachExternalLabel()` /
 *     `attachSupplierOrderReference()` (reconciliación), nunca un
 *     retry ciego (plan §17/§18).
 */

function requireNonEmpty(value: string, fieldName: string): void {
  if (!value || value.trim().length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `"${fieldName}" es obligatorio para una operación manual`)
  }
}

function isAmbiguousReview(manualReviewReason: string | null): boolean {
  return (manualReviewReason ?? "").startsWith("AMBIGUOUS_")
}

interface ManualOperationInput {
  warehouseShipmentId: string
  actor: string
  reason: string
}

// ---------------------------------------------------------------------
// 1. retryLabelPurchaseWorkflow (plan §17)
// ---------------------------------------------------------------------

const LABEL_RETRY_ELIGIBLE_STATUSES: WarehouseShipmentStatus[] = ["LABEL_FAILED_RETRYABLE", "LABEL_FAILED_FINAL"]

const retryLabelPurchaseStep = createStep(
  "retry-label-purchase",
  async (input: ManualOperationInput, { container }) => {
    requireNonEmpty(input.actor, "actor")
    requireNonEmpty(input.reason, "reason")

    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const shipment = await fulfillmentService.retrieveWarehouseShipment(input.warehouseShipmentId)
    const previousStatus = shipment.status as WarehouseShipmentStatus

    if (isAmbiguousReview(shipment.manual_review_reason)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} tiene una compra de guía AMBIGUA -- usa attachExternalLabel() para reconciliar, nunca un retry ciego (plan §17).`
      )
    }
    if (!LABEL_RETRY_ELIGIBLE_STATUSES.includes(previousStatus)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} está en estado ${previousStatus} -- solo se puede reintentar la compra de guía desde ${LABEL_RETRY_ELIGIBLE_STATUSES.join(" o ")}.`
      )
    }

    // `LABEL_FAILED_RETRYABLE` ya es elegible para el workflow automático
    // (pasa directo a LABEL_PURCHASING, nunca por READY_FOR_LABEL --
    // VALID_TRANSITIONS no modela ese salto porque nunca es un cambio de
    // status real) -- lo único que bloquea un retry AHORA es el backoff
    // (5/15/60 min). Un retry manual aquí solo adelanta el reloj
    // (resetea contadores) SIN transición de estado. Solo
    // `LABEL_FAILED_FINAL` (agotó la política) necesita la transición
    // real de vuelta a READY_FOR_LABEL para volver a ser elegible.
    const newStatus: WarehouseShipmentStatus =
      previousStatus === "LABEL_FAILED_FINAL" ? "READY_FOR_LABEL" : previousStatus

    if (newStatus !== previousStatus) {
      assertValidTransition(input.warehouseShipmentId, previousStatus, newStatus)
    }

    await fulfillmentService.updateWarehouseShipments([
      {
        id: input.warehouseShipmentId,
        status: newStatus,
        label_attempt_count: 0,
        label_last_attempt_at: null,
        label_last_error_code: null,
        label_last_error_message: null,
        requires_manual_review: false,
        manual_review_reason: null,
      },
    ])

    await emitEvent(
      container,
      input.warehouseShipmentId,
      "WAREHOUSE_SHIPMENT_RETRY_SCHEDULED",
      { operation: "retryLabelPurchase", reason: input.reason, previousState: previousStatus, newState: newStatus },
      input.actor
    )

    return new StepResponse({ warehouseShipmentId: input.warehouseShipmentId, previousStatus, newStatus })
  }
)

export const retryLabelPurchaseWorkflow = createWorkflow("retry-label-purchase", (input: ManualOperationInput) => {
  return new WorkflowResponse(retryLabelPurchaseStep(input))
})

// ---------------------------------------------------------------------
// 2. retrySupplierSubmissionWorkflow (plan §18)
// ---------------------------------------------------------------------

const SUPPLIER_RETRY_ELIGIBLE_STATUSES: WarehouseShipmentStatus[] = ["SUPPLIER_FAILED_RETRYABLE", "SUPPLIER_FAILED_FINAL"]

const retrySupplierSubmissionStep = createStep(
  "retry-supplier-submission",
  async (input: ManualOperationInput, { container }) => {
    requireNonEmpty(input.actor, "actor")
    requireNonEmpty(input.reason, "reason")

    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const shipment = await fulfillmentService.retrieveWarehouseShipment(input.warehouseShipmentId)
    const previousStatus = shipment.status as WarehouseShipmentStatus

    if (shipment.supplier_order_reference) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} ya tiene supplier_order_reference (${shipment.supplier_order_reference}) -- nunca reenviar un pedido ya aceptado.`
      )
    }
    if (isAmbiguousReview(shipment.manual_review_reason)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} tiene un envío al proveedor AMBIGUO -- usa attachSupplierOrderReference() para reconciliar, nunca un retry ciego (plan §18).`
      )
    }
    if (!SUPPLIER_RETRY_ELIGIBLE_STATUSES.includes(previousStatus)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} está en estado ${previousStatus} -- solo se puede reintentar el envío al proveedor desde ${SUPPLIER_RETRY_ELIGIBLE_STATUSES.join(" o ")}.`
      )
    }

    // Mismo razonamiento que retryLabelPurchase: `SUPPLIER_FAILED_RETRYABLE`
    // ya es elegible automáticamente (pasa directo a SUPPLIER_SUBMITTING,
    // nunca por SUPPLIER_SUBMISSION_PENDING) -- un retry manual aquí solo
    // adelanta el backoff, sin transición de estado. Solo
    // `SUPPLIER_FAILED_FINAL` necesita la transición real.
    const newStatus: WarehouseShipmentStatus =
      previousStatus === "SUPPLIER_FAILED_FINAL" ? "SUPPLIER_SUBMISSION_PENDING" : previousStatus

    if (newStatus !== previousStatus) {
      assertValidTransition(input.warehouseShipmentId, previousStatus, newStatus)
    }

    await fulfillmentService.updateWarehouseShipments([
      {
        id: input.warehouseShipmentId,
        status: newStatus,
        supplier_attempt_count: 0,
        supplier_last_attempt_at: null,
        supplier_last_error_code: null,
        supplier_last_error_message: null,
        requires_manual_review: false,
        manual_review_reason: null,
      },
    ])

    await emitEvent(
      container,
      input.warehouseShipmentId,
      "WAREHOUSE_SHIPMENT_RETRY_SCHEDULED",
      {
        operation: "retrySupplierSubmission",
        reason: input.reason,
        previousState: previousStatus,
        newState: newStatus,
      },
      input.actor
    )

    return new StepResponse({
      warehouseShipmentId: input.warehouseShipmentId,
      previousStatus,
      newStatus,
    })
  }
)

export const retrySupplierSubmissionWorkflow = createWorkflow(
  "retry-supplier-submission",
  (input: ManualOperationInput) => {
    return new WorkflowResponse(retrySupplierSubmissionStep(input))
  }
)

// ---------------------------------------------------------------------
// 3. markWarehouseShipmentForManualReviewWorkflow (plan §21)
// ---------------------------------------------------------------------

export interface MarkForManualReviewInput extends ManualOperationInput {
  context?: Record<string, unknown>
}

const markForManualReviewStep = createStep(
  "mark-for-manual-review",
  async (input: MarkForManualReviewInput, { container }) => {
    requireNonEmpty(input.actor, "actor")
    requireNonEmpty(input.reason, "reason")

    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const shipment = await fulfillmentService.retrieveWarehouseShipment(input.warehouseShipmentId)
    const previousStatus = shipment.status as WarehouseShipmentStatus

    if (isTerminal(previousStatus)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} está en estado terminal (${previousStatus}) -- no se puede marcar para revisión.`
      )
    }

    if (previousStatus !== "REQUIRES_MANUAL_REVIEW") {
      assertValidTransition(input.warehouseShipmentId, previousStatus, "REQUIRES_MANUAL_REVIEW")
      await fulfillmentService.updateWarehouseShipments([
        {
          id: input.warehouseShipmentId,
          status: "REQUIRES_MANUAL_REVIEW",
          requires_manual_review: true,
          manual_review_reason: input.reason,
        },
      ])
    } else {
      // Ya estaba en revisión -- no es una transición nueva, solo se
      // registra una nota adicional (idempotente, nunca duplica estado).
      await fulfillmentService.updateWarehouseShipments([{ id: input.warehouseShipmentId, manual_review_reason: input.reason }])
    }

    await emitEvent(
      container,
      input.warehouseShipmentId,
      "WAREHOUSE_SHIPMENT_MANUAL_REVIEW",
      { reason: input.reason, previousState: previousStatus, newState: "REQUIRES_MANUAL_REVIEW", context: input.context ?? {} },
      input.actor
    )

    return new StepResponse({
      warehouseShipmentId: input.warehouseShipmentId,
      previousStatus,
      newStatus: "REQUIRES_MANUAL_REVIEW" as const,
    })
  }
)

export const markWarehouseShipmentForManualReviewWorkflow = createWorkflow(
  "mark-warehouse-shipment-for-manual-review",
  (input: MarkForManualReviewInput) => {
    return new WorkflowResponse(markForManualReviewStep(input))
  }
)

// ---------------------------------------------------------------------
// 4. attachExternalLabelWorkflow (plan §19)
// ---------------------------------------------------------------------

export interface AttachExternalLabelInput extends ManualOperationInput {
  providerShipmentId: string
  trackingNumber: string
  /** Referencia/URL de storage (plan §18/§43) -- NUNCA el PDF base64 ni una respuesta cruda del proveedor. */
  labelReference: string
  providerCostAmount?: number
}

const attachExternalLabelStep = createStep(
  "attach-external-label",
  async (input: AttachExternalLabelInput, { container }) => {
    requireNonEmpty(input.actor, "actor")
    requireNonEmpty(input.reason, "reason")
    requireNonEmpty(input.providerShipmentId, "providerShipmentId")
    requireNonEmpty(input.trackingNumber, "trackingNumber")
    requireNonEmpty(input.labelReference, "labelReference")

    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const shipment = await fulfillmentService.retrieveWarehouseShipment(input.warehouseShipmentId)
    const previousStatus = shipment.status as WarehouseShipmentStatus

    if (previousStatus !== "REQUIRES_MANUAL_REVIEW") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} está en estado ${previousStatus} -- attachExternalLabel() solo aplica a un shipment en REQUIRES_MANUAL_REVIEW (plan §19).`
      )
    }

    assertValidTransition(input.warehouseShipmentId, previousStatus, "LABEL_PURCHASED")
    // No se borra el historial anterior (plan §19) -- `label_attempt_count`
    // y los `label_last_error_*` de los intentos previos se conservan tal
    // cual; solo se llenan los campos del resultado confirmado.
    await fulfillmentService.updateWarehouseShipments([
      {
        id: input.warehouseShipmentId,
        status: "LABEL_PURCHASED",
        provider_shipment_id: input.providerShipmentId,
        tracking_number: input.trackingNumber,
        label_reference: input.labelReference,
        provider_cost_amount: input.providerCostAmount ?? null,
        requires_manual_review: false,
        manual_review_reason: null,
      },
    ])

    await emitEvent(
      container,
      input.warehouseShipmentId,
      "LABEL_PURCHASED",
      {
        attachedManually: true,
        reason: input.reason,
        previousState: previousStatus,
        newState: "LABEL_PURCHASED",
        providerShipmentId: input.providerShipmentId,
        trackingNumber: input.trackingNumber,
      },
      input.actor
    )

    return new StepResponse({ warehouseShipmentId: input.warehouseShipmentId, previousStatus, newStatus: "LABEL_PURCHASED" as const })
  }
)

export const attachExternalLabelWorkflow = createWorkflow("attach-external-label", (input: AttachExternalLabelInput) => {
  return new WorkflowResponse(attachExternalLabelStep(input))
})

// ---------------------------------------------------------------------
// 5. attachSupplierOrderReferenceWorkflow (plan §20)
// ---------------------------------------------------------------------

export interface AttachSupplierOrderReferenceInput extends ManualOperationInput {
  supplierOrderReference: string
  rawStatus?: string
}

const attachSupplierOrderReferenceStep = createStep(
  "attach-supplier-order-reference",
  async (input: AttachSupplierOrderReferenceInput, { container }) => {
    requireNonEmpty(input.actor, "actor")
    requireNonEmpty(input.reason, "reason")
    requireNonEmpty(input.supplierOrderReference, "supplierOrderReference")

    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const shipment = await fulfillmentService.retrieveWarehouseShipment(input.warehouseShipmentId)
    const previousStatus = shipment.status as WarehouseShipmentStatus

    if (previousStatus !== "REQUIRES_MANUAL_REVIEW") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} está en estado ${previousStatus} -- attachSupplierOrderReference() solo aplica a un shipment en REQUIRES_MANUAL_REVIEW (plan §20).`
      )
    }

    assertValidTransition(input.warehouseShipmentId, previousStatus, "SUPPLIER_ACCEPTED")
    await fulfillmentService.updateWarehouseShipments([
      {
        id: input.warehouseShipmentId,
        status: "SUPPLIER_ACCEPTED",
        supplier_order_reference: input.supplierOrderReference,
        supplier_order_status: input.rawStatus ?? null,
        requires_manual_review: false,
        manual_review_reason: null,
      },
    ])

    await emitEvent(
      container,
      input.warehouseShipmentId,
      "SUPPLIER_ORDER_ACCEPTED",
      {
        attachedManually: true,
        reason: input.reason,
        previousState: previousStatus,
        newState: "SUPPLIER_ACCEPTED",
        supplierOrderReference: input.supplierOrderReference,
      },
      input.actor
    )

    return new StepResponse({ warehouseShipmentId: input.warehouseShipmentId, previousStatus, newStatus: "SUPPLIER_ACCEPTED" as const })
  }
)

export const attachSupplierOrderReferenceWorkflow = createWorkflow(
  "attach-supplier-order-reference",
  (input: AttachSupplierOrderReferenceInput) => {
    return new WorkflowResponse(attachSupplierOrderReferenceStep(input))
  }
)

// ---------------------------------------------------------------------
// 6. cancelWarehouseShipmentWorkflow (plan §22)
// ---------------------------------------------------------------------

/** Ninguno de estos estados implica que una guía real se haya comprado -- seguro cerrar localmente, nunca finge revertir un side effect externo que nunca ocurrió. */
const NEVER_HAD_SIDE_EFFECT: WarehouseShipmentStatus[] = [
  "PENDING",
  "READY_FOR_LABEL",
  "LABEL_FAILED_RETRYABLE",
  "LABEL_FAILED_FINAL",
]

export type CancelWarehouseShipmentOutcome = "CANCELLED" | "CANCELLATION_REQUIRES_MANUAL_ACTION"

const cancelWarehouseShipmentStep = createStep(
  "cancel-warehouse-shipment",
  async (input: ManualOperationInput, { container }) => {
    requireNonEmpty(input.actor, "actor")
    requireNonEmpty(input.reason, "reason")

    const fulfillmentService = container.resolve<SupplierFulfillmentModuleService>(SUPPLIER_FULFILLMENT_MODULE)
    const shipment = await fulfillmentService.retrieveWarehouseShipment(input.warehouseShipmentId)
    const previousStatus = shipment.status as WarehouseShipmentStatus

    if (isTerminal(previousStatus)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `WarehouseShipment ${input.warehouseShipmentId} ya está en estado terminal (${previousStatus}) -- nada que cancelar.`
      )
    }

    if (NEVER_HAD_SIDE_EFFECT.includes(previousStatus)) {
      assertValidTransition(input.warehouseShipmentId, previousStatus, "CANCELLED")
      await fulfillmentService.updateWarehouseShipments([
        { id: input.warehouseShipmentId, status: "CANCELLED", cancelled_at: new Date() },
      ])
      await emitEvent(
        container,
        input.warehouseShipmentId,
        "WAREHOUSE_SHIPMENT_CANCELLED",
        { reason: input.reason, previousState: previousStatus, newState: "CANCELLED", localOnly: true },
        input.actor
      )
      return new StepResponse({
        warehouseShipmentId: input.warehouseShipmentId,
        previousStatus,
        outcome: "CANCELLED" as CancelWarehouseShipmentOutcome,
      })
    }

    // Plan §22: ya existe (o pudo existir) un side effect externo real
    // (guía comprada y/o pedido enviado al proveedor) y todavía no hay
    // una API de cancelación real integrada -- NUNCA fingir que se
    // canceló. Se deja documentado en REQUIRES_MANUAL_REVIEW para que un
    // operador decida (cancelar de verdad con el carrier/proveedor, o
    // dejar que el fulfillment siga su curso).
    if (previousStatus !== "REQUIRES_MANUAL_REVIEW") {
      assertValidTransition(input.warehouseShipmentId, previousStatus, "REQUIRES_MANUAL_REVIEW")
      await fulfillmentService.updateWarehouseShipments([
        {
          id: input.warehouseShipmentId,
          status: "REQUIRES_MANUAL_REVIEW",
          requires_manual_review: true,
          manual_review_reason: `CANCELLATION_REQUIRES_MANUAL_ACTION: ${input.reason}`,
        },
      ])
    } else {
      await fulfillmentService.updateWarehouseShipments([
        {
          id: input.warehouseShipmentId,
          manual_review_reason: `CANCELLATION_REQUIRES_MANUAL_ACTION: ${input.reason}`,
        },
      ])
    }

    await emitEvent(
      container,
      input.warehouseShipmentId,
      "WAREHOUSE_SHIPMENT_MANUAL_REVIEW",
      {
        reason: "CANCELLATION_REQUIRES_MANUAL_ACTION",
        requestedReason: input.reason,
        previousState: previousStatus,
        newState: "REQUIRES_MANUAL_REVIEW",
      },
      input.actor
    )

    return new StepResponse({
      warehouseShipmentId: input.warehouseShipmentId,
      previousStatus,
      outcome: "CANCELLATION_REQUIRES_MANUAL_ACTION" as CancelWarehouseShipmentOutcome,
    })
  }
)

export const cancelWarehouseShipmentWorkflow = createWorkflow("cancel-warehouse-shipment", (input: ManualOperationInput) => {
  return new WorkflowResponse(cancelWarehouseShipmentStep(input))
})
