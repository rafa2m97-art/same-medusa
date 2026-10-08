import type {
  ExelAlmacenDto,
  ExelCreateOrderDireccion,
  ExelCreateOrderRequest,
  ExelCreateOrderResponse,
  ExelProductDto,
  ExelProductWithWarehousesDto,
} from "./types"
import type {
  LiveConfirmationResult,
  NormalizedCatalogTotal,
  NormalizedSupplierProduct,
  NormalizedWarehouseStock,
  SupplierOrderRequest,
  SupplierOrderResult,
  SupplierWarehouseDescriptor,
} from "../../../modules/supplier/types"

/**
 * Esta es la ÚNICA capa que conoce la forma cruda de Exel. Todo lo que
 * sale de aquí hacia el dominio (src/modules/supplier) usa los DTOs
 * normalizados genéricos — nunca `clave_almacen`, `referencia`,
 * `almacen_clave`, etc.
 */

// ---- Catálogo / inventario: Exel -> normalizado ----

/**
 * NOTA sobre el campo de costo: Exel manda `precio`, `precio_oferta` y
 * `precio_sin_oferta` — los tres son precio de COSTO para SAME (Exel le
 * ofrece un descuento de costo, no es un precio público). Se usa `precio`
 * (el costo vigente) como fuente — cuál de los tres es exactamente el
 * correcto para la fórmula de margen (ceil((costo/0.95)*1.16)) es una
 * decisión de Etapa 5 (Pricing), a verificar contra
 * /opt/exel_sync/generar_precios_exel.py cuando se implemente pricing
 * real; aquí solo se normaliza el dato, no se decide la regla de negocio.
 */
export function normalizeExelProduct(
  dto: ExelProductDto
): NormalizedSupplierProduct {
  return {
    supplierSku: dto.sku,
    supplierInternalRef: dto.referencia,
    name: dto.nombre,
    description: dto.descripcion_extendida || undefined,
    brandName: dto.marca_nombre || undefined,
    categoryName: dto.categoria_nombre || undefined,
    images: [],
    costPrice: parseFloat(dto.precio),
    currency: dto.moneda || "MXN",
  }
}

export function normalizeExelWarehouse(
  dto: ExelAlmacenDto
): SupplierWarehouseDescriptor {
  return {
    externalCode: dto.clave,
    name: dto.nombre,
    address: dto.direccion?.calle,
    city: dto.direccion?.ciudad,
    state: dto.direccion?.estado,
    country: "MX",
  }
}

export function normalizeExelWarehouseStock(
  dto: ExelProductWithWarehousesDto
): NormalizedWarehouseStock[] {
  return dto.almacenes.map((wh) => ({
    warehouseExternalCode: wh.almacen_clave,
    supplierSku: dto.sku,
    quantity: wh.stock,
  }))
}

export function normalizeExelCatalogTotal(
  dto: ExelProductDto
): NormalizedCatalogTotal {
  return {
    supplierSku: dto.sku,
    totalQuantity: parseInt(dto.stock, 10) || 0,
  }
}

// ---- Fulfillment: SupplierOrderRequest normalizado -> Exel ----

const EXTERNAL_LABEL_CARRIER_CODE = "GPCL" // "GUIA PAGADA POR CLTE" — confirmado en GET /almacenes real

function splitPhoneForExel(phone?: string): { lada: string; telefono: string } {
  const digits = (phone || "").replace(/\D+/g, "")
  if (digits.length === 10) {
    return { lada: "", telefono: digits }
  }
  if (digits.length > 10) {
    return {
      lada: digits.slice(0, digits.length - 10),
      telefono: digits.slice(-10),
    }
  }
  return { lada: "", telefono: digits.padStart(10, "0") }
}

function buildExelDireccion(
  destination: SupplierOrderRequest["destination"]
): ExelCreateOrderDireccion {
  const phoneParts = splitPhoneForExel(destination.phone)
  return {
    colonia: destination.neighborhood || "Sin colonia",
    codigo_postal: destination.postalCode || "00000",
    // Exel exige máximo 40 caracteres en "calle" (HTTP 400 si se excede) —
    // ver class-msl-exel-api.php::prepare_address_data. Se trunca aquí
    // también, en el borde de una palabra, igual que el sistema actual.
    calle: truncateStreet(destination.street || "Sin calle", 40),
    numero_exterior: destination.exteriorNumber || "0",
    numero_interior: destination.interiorNumber || "",
    referencias: destination.notes || "",
    contacto_nombre: destination.contactName || "Cliente",
    correo: destination.email || "",
    lada: phoneParts.lada,
    telefono: phoneParts.telefono,
  }
}

function truncateStreet(street: string, maxLength: number): string {
  if (street.length <= maxLength) return street
  const truncated = street.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(" ")
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated
}

/**
 * Construye el request crudo de Exel a partir de UN SupplierOrderRequest
 * normalizado — que ya representa el fulfillment de UN solo almacén (ver
 * nota de la regla "un pedido Exel por almacén" en modules/supplier/types.ts).
 * `clave_transportista` siempre es "GPCL" porque SAME siempre entrega una
 * guía ya comprada por su cuenta — nunca deja que Exel gestione el
 * transporte.
 */
export function buildExelCreateOrderRequest(
  req: SupplierOrderRequest,
  warehouseExternalCode: string
): ExelCreateOrderRequest {
  return {
    clave_almacen: warehouseExternalCode,
    clave_transportista: EXTERNAL_LABEL_CARRIER_CODE,
    orden_confirmada: true,
    comentario: req.comment || `Pedido SAME ${req.referenceId}`,
    productos: req.lines.map((line) => ({
      clave_producto: line.supplierSku,
      cantidad: line.quantity,
    })),
    direccion: buildExelDireccion(req.destination),
    envio: req.shipping
      ? {
          guia: req.shipping.trackingNumber,
          base64pdf: req.shipping.labelBase64,
          num_orden: req.referenceId,
          formato: req.shipping.labelFormat || "PDF",
        }
      : undefined,
    // Objeto vacío requerido por la API real de Exel -- ver docblock en types.ts.
    recolector: {},
  }
}

/**
 * Exel responde 200/201 con el pedido ya creado en
 * `resultado.Numero_Orden`, o solo `resultado.correcto=1` sin número
 * visible (en ese caso se sintetiza un id local con prefijo EXEL-). No
 * hay en la documentación de Exel ninguna lista de códigos de error
 * retryable/non-retryable — se trata como retryable por defecto salvo
 * errores de red/timeout evidentes, igual que el comportamiento real hoy
 * (class-msl-exel-api.php::handle_send_failure solo distingue errores de
 * CONFIGURACIÓN local como no-retryables, nunca por el contenido de la
 * respuesta de Exel).
 */
export function parseExelCreateOrderResponse(
  httpStatus: number,
  data: ExelCreateOrderResponse | null
): SupplierOrderResult {
  if (httpStatus !== 200 && httpStatus !== 201) {
    return {
      success: false,
      error: data?.mensaje || `HTTP ${httpStatus} inesperado de Exel`,
      retryable: true,
    }
  }

  const resultado = data?.resultado
  let exelOrderId: string | undefined

  if (resultado?.Numero_Orden) {
    exelOrderId = resultado.Numero_Orden
  } else if (resultado?.correcto === 1) {
    exelOrderId = `EXEL-${Date.now()}`
  }

  if (exelOrderId) {
    return {
      success: true,
      supplierOrderId: exelOrderId,
      rawStatus: resultado?.Estatus,
    }
  }

  return {
    success: false,
    error: data?.mensaje || "Respuesta inesperada de Exel",
    rawStatus: resultado?.Estatus,
    retryable: true,
  }
}

export function buildLiveConfirmationResult(
  requestedQuantity: number,
  confirmedQuantity: number,
  warehouseExternalCode: string
): LiveConfirmationResult {
  if (confirmedQuantity >= requestedQuantity) {
    return {
      confirmed: true,
      status: "CONFIRMED",
      confirmedQuantityByWarehouse: { [warehouseExternalCode]: confirmedQuantity },
    }
  }
  return {
    confirmed: false,
    status: "REJECTED",
    reason: `Exel solo confirma ${confirmedQuantity} unidad(es) en ${warehouseExternalCode}, se solicitaron ${requestedQuantity}`,
    confirmedQuantityByWarehouse: { [warehouseExternalCode]: confirmedQuantity },
  }
}
