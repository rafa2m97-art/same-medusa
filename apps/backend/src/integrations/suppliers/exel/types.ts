/**
 * Formas CRUDAS reales de la API de Exel del Norte — toda la rareza de
 * Exel vive aquí, nunca se filtra al dominio SAME (src/modules/supplier).
 *
 * Fuente: documentación OFICIAL real de la API
 * (investigation-78767/exel-api-docs.json, 22 endpoints, exportada de su
 * portal de documentación — no inventada) + el código real de
 * class-msl-exel-api.php donde la documentación no alcanza. Base:
 * https://api01.exeldelnorte.com.mx — autenticación: header
 * `Authorization: <api_key_cruda>`, SIN prefijo "Bearer" (confirmado en
 * ambos: código real y por inspección, ningún parámetro "Bearer" aparece
 * en los 22 endpoints documentados).
 */

// ---- GET /productos (catálogo completo) ----
// GET /productos?sin_stock=true&marca=&subcategoria=&categoria=&familia=
// Todos los filtros son querystring opcionales. IMPORTANTE (confirmado en
// producción, no solo documentación): sin sin_stock=true, Exel oculta
// productos en stock 0 — justo la población más importante para detectar
// sobreventa.
export interface ExelProductDto {
  id: string
  referencia: string
  sku: string
  codigo_barras?: string
  codigo_sat?: string
  nombre: string
  descripcion_extendida?: string
  stock: string // numérico como string, tal cual lo manda Exel
  precio: string
  precio_oferta: string
  precio_sin_oferta: string
  oferta: boolean
  moneda: string
  marca_id?: string
  marca_nombre?: string
  familia_id?: string
  familia_nombre?: string
  subcategoria_id?: string
  subcategoria_nombre?: string
  categoria_id?: string
  categoria_nombre?: string
}

export interface ExelProductosResponse {
  resultado: boolean
  mensaje: string
  datos: ExelProductDto[]
}

// ---- POST /productos_almacenes (desglose de stock por almacén) ----
// Documentado como POST con body {"skus": [...]} (máx. 100 SKUs). HALLAZGO:
// la integración real en producción NUNCA usa este filtro — siempre trae
// el catálogo completo vía GET plano sin body y filtra localmente,
// aparentemente por un problema histórico al enviar el filtro (ver
// HALLAZGOS de la Etapa 2). El contrato de abajo modela la forma
// documentada tal cual, no la forma en que el código actual la usa — el
// ExelAdapter de esta etapa soporta ambos caminos (ver exel-adapter.ts).
export interface ExelWarehouseBreakdownDto {
  stock: number
  almacen: string
  almacen_clave: string
}

export interface ExelProductWithWarehousesDto extends Omit<ExelProductDto, "stock"> {
  stock: string
  almacenes: ExelWarehouseBreakdownDto[]
}

export interface ExelProductosAlmacenesResponse {
  resultado: boolean
  mensaje: string
  datos: ExelProductWithWarehousesDto[]
}

// ---- GET /almacenes ----
export interface ExelAlmacenDireccionDto {
  calle: string
  "numero exterior": string
  "numero interior": string
  colonia: string
  "codigo postal": string
  ciudad: string
  estado: string
}

export interface ExelTransportistaDto {
  clave: string
  nombre: string
}

export interface ExelAlmacenDto {
  clave: string
  nombre: string
  direccion: ExelAlmacenDireccionDto
  tranportistas: ExelTransportistaDto[] // sic — "tranportistas", así está en la API real
}

export interface ExelAlmacenesResponse {
  resultado: boolean
  mensaje: string
  datos: ExelAlmacenDto[]
}

// ---- POST /pedido (creación de pedido) ----
//
// Esquema documentado oficialmente (parámetros BODY, requerido según la
// propia documentación de Exel):
//   clave_almacen (string, requerido)
//   orden_confirmada (boolean, OPCIONAL — true = orden confirmada, false/
//     omitido = pre-orden que luego hay que confirmar vía GET
//     /confirma_preorden?num_orden=...; el código real SIEMPRE manda true,
//     nunca usa el flujo de pre-orden)
//   clave_transportista (string, OPCIONAL) — el ejemplo oficial usa el
//     mismo valor que clave_almacen (ej. "GD"); el código real en
//     producción usa SIEMPRE "GPCL" ("GUIA PAGADA POR CLTE", confirmado
//     contra GET /almacenes: es un transportista real documentado,
//     significa "Exel no gestiona el transporte, el cliente ya pagó su
//     propia guía") — NUNCA el código de almacén.
//   comentario (string, opcional)
//   productos[].clave_producto (string, requerido)
//   productos[].cantidad (int, requerido)
//   direccion.colonia / codigo_postal / calle / numero_exterior /
//     referencias / contacto_nombre / correo / lada / telefono
//     (TODOS requerido=1 según documentación oficial)
//   direccion.numero_interior (requerido=0)
//   envio.guia / envio.base64pdf / envio.num_orden / envio.formato
//     (TODOS requerido=0 en la documentación — es decir, Exel no exige
//     guía para crear el pedido; es SAME quien decide, como regla de
//     negocio propia, no crear el pedido hasta tener la guía comprada)
//   id_recolector (requerido=0, "únicamente cuando clave_transportista es
//     PRCL" — como el código real siempre usa "GPCL", este campo nunca
//     aplica en el flujo actual de SAME)
//
// `recolector: {}` (objeto vacío) que manda el código real NO aparece en
// ningún parámetro documentado de /pedido — el único campo documentado
// relacionado a recolectores es `id_recolector` (string), condicionado a
// clave_transportista=PRCL. Como SAME siempre usa GPCL, es consistente
// con la documentación que `recolector`/`id_recolector` sean irrelevantes
// para SAME — el objeto vacío parece un workaround defensivo del
// desarrollador original más que un requisito real para este transportista.
export interface ExelCreateOrderProductLine {
  clave_producto: string
  cantidad: number
}

export interface ExelCreateOrderDireccion {
  colonia: string
  codigo_postal: string
  calle: string
  numero_exterior: string
  numero_interior?: string
  referencias: string
  contacto_nombre: string
  correo: string
  lada: string
  telefono: string
}

export interface ExelCreateOrderEnvio {
  guia?: string
  base64pdf?: string
  num_orden?: string
  formato?: "PDF" | "ZPL"
}

export interface ExelCreateOrderRequest {
  clave_almacen: string
  clave_transportista?: string
  orden_confirmada?: boolean
  comentario?: string
  productos: ExelCreateOrderProductLine[]
  direccion: ExelCreateOrderDireccion
  envio?: ExelCreateOrderEnvio
  /**
   * Corregido en Etapa 9 (SSH 2026-10-06, send_warehouse_order real):
   * Exel exige un objeto `recolector` VACÍO en cada request -- no es un
   * id de texto. No aparece documentado, la API simplemente lo requiere
   * (comentario real: "Requerido por la API actual de Exel aunque no
   * aparece en la documentación"). Se reemplaza el `id_recolector?:
   * string` anterior (nunca se había verificado contra una llamada real
   * de creación de pedido hasta esta etapa).
   */
  recolector: Record<string, never>
}

// Respuesta documentada oficialmente (ejemplo real capturado en la doc):
// { "resultado": {"Numero_Orden": "903372777", "Estatus": "r", "Total":
// "30", "correcto": 1, "envio": "Guia de envio: REGISTRO INSERTADO"},
// "mensaje": "", "datos": "" }
// El significado exacto de "Estatus": "r" no está documentado — se
// captura tal cual, sin inventar su significado.
export interface ExelCreateOrderResultado {
  Numero_Orden?: string
  Estatus?: string
  Total?: string
  correcto?: number
  envio?: string
}

export interface ExelCreateOrderResponse {
  resultado?: ExelCreateOrderResultado
  mensaje?: string
  datos?: string
}

/** Forma de error real observada (ej. 400 "Falta token de autorización"). */
export interface ExelApiError {
  httpStatus: number
  message: string
  rawBody?: unknown
}
