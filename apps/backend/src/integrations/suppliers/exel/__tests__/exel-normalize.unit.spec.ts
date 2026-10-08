import productosFixture from "../__fixtures__/productos.json"
import productosAlmacenesFixture from "../__fixtures__/productos_almacenes.json"
import almacenesFixture from "../__fixtures__/almacenes.json"
import type {
  ExelAlmacenesResponse,
  ExelProductosAlmacenesResponse,
  ExelProductosResponse,
} from "../types"
import {
  buildExelCreateOrderRequest,
  normalizeExelCatalogTotal,
  normalizeExelProduct,
  normalizeExelWarehouse,
  normalizeExelWarehouseStock,
  parseExelCreateOrderResponse,
} from "../normalize"
import { ExelPricingAdapter } from "../exel-pricing"
import type { SupplierOrderRequest } from "../../../../modules/supplier/types"

/**
 * Fixtures: basados textualmente en los ejemplos de la documentación
 * OFICIAL real de Exel del Norte (investigation-78767/exel-api-docs.json),
 * no inventados. El segundo producto de productos.json se editó a
 * stock "0" a propósito, para ejercer ese caso (el ejemplo oficial no
 * tenía ningún producto en 0).
 */

// 9. Normalizar un fixture real de Exel a DTO genérico.
describe("ExelAdapter — normalización catálogo/inventario", () => {
  it("normaliza GET /productos al DTO genérico NormalizedSupplierProduct", () => {
    const fixture = productosFixture as ExelProductosResponse
    const normalized = fixture.datos.map(normalizeExelProduct)

    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toEqual({
      supplierSku: "680-5",
      supplierInternalRef: "3MPBADAB001",
      name: "Banderitas 3M 680 Post It Amarillo 12 Piezas c/50 Hojas c/u",
      description: undefined,
      brandName: "3M",
      categoryName: "Oficina y Escolar",
      images: [],
      costPrice: 382.5332,
      currency: "MXN",
    })
  })

  it("normaliza correctamente un producto con stock 0 (caso sin_stock)", () => {
    const fixture = productosFixture as ExelProductosResponse
    const zeroStockProduct = fixture.datos[1]
    const total = normalizeExelCatalogTotal(zeroStockProduct)

    expect(total).toEqual({ supplierSku: "WR209MB", totalQuantity: 0 })
  })

  it("normaliza POST /productos_almacenes a NormalizedWarehouseStock[] (uno por almacén)", () => {
    const fixture = productosAlmacenesFixture as ExelProductosAlmacenesResponse
    const normalized = normalizeExelWarehouseStock(fixture.datos[0])

    expect(normalized).toHaveLength(11)
    expect(normalized).toContainEqual({
      warehouseExternalCode: "MY",
      supplierSku: "WR209MB",
      quantity: 38,
    })
    expect(normalized).toContainEqual({
      warehouseExternalCode: "GD",
      supplierSku: "WR209MB",
      quantity: 0,
    })
  })

  it("normaliza GET /almacenes a SupplierWarehouseDescriptor genérico", () => {
    const fixture = almacenesFixture as ExelAlmacenesResponse
    const normalized = normalizeExelWarehouse(fixture.datos[0])

    expect(normalized).toEqual({
      externalCode: "CH",
      name: "CHIHUAHUA",
      address: "Heroico Colegio Militar",
      city: "Chihuahua",
      state: "Chihuahua",
      country: "MX",
    })
  })

  // 10. Demostrar que estructuras específicas de Exel NUNCA escapan al dominio.
  it("el DTO normalizado no contiene ninguna clave cruda de Exel", () => {
    const fixture = productosFixture as ExelProductosResponse
    const normalized = normalizeExelProduct(fixture.datos[0])

    const exelOnlyKeys = [
      "referencia",
      "codigo_barras",
      "codigo_sat",
      "precio_oferta",
      "precio_sin_oferta",
      "marca_id",
      "familia_id",
      "subcategoria_id",
      "categoria_id",
      "almacen_clave",
      "clave_almacen",
      "clave_producto",
      "clave_transportista",
    ]
    for (const key of exelOnlyKeys) {
      expect(Object.keys(normalized)).not.toContain(key)
    }

    const warehouseStock = normalizeExelWarehouseStock(
      (productosAlmacenesFixture as ExelProductosAlmacenesResponse).datos[0]
    )[0]
    expect(Object.keys(warehouseStock)).not.toContain("almacen_clave")
    expect(Object.keys(warehouseStock)).not.toContain("almacen")
  })
})

describe("ExelAdapter — fórmula de precio (margen 5% + IVA 16%, tax-inclusive)", () => {
  it("costo 100 -> precio público 123 (caso de prueba del plan)", () => {
    const pricing = new ExelPricingAdapter()
    expect(pricing.computePublicPrice(100, "MXN")).toEqual(123)
  })

  it("redondea siempre hacia arriba al peso entero", () => {
    const pricing = new ExelPricingAdapter()
    // 382.5332 / 0.95 * 1.16 = 467.44... -> 468
    expect(pricing.computePublicPrice(382.5332, "MXN")).toEqual(468)
  })
})

describe("ExelAdapter — mapeo SupplierOrderRequest -> POST /pedido (campo por campo)", () => {
  // Reproduce el ejemplo de la documentación oficial de Exel (api_id 34,
  // dsapipe_id 172) para validar que el mapeo de direccion/productos es
  // fiel. EXCEPCIÓN DOCUMENTADA: el teléfono del ejemplo oficial
  // ("lada":"871", "telefono":"1854819", 3+7=10 dígitos) usa la
  // convención telefónica mexicana antigua (lada de 3 + local de 7). La
  // función real de producción (split_phone en class-msl-exel-api.php)
  // asume siempre un número plano de 10 dígitos sin lada separada salvo
  // que haya MÁS de 10 dígitos — son dos convenciones distintas y no se
  // puede reproducir el ejemplo ilustrativo sin cambiar el algoritmo
  // real. Este test usa un teléfono de 13 dígitos (con lada real de 3)
  // para ejercer la rama real de split_phone con lada no vacía, en vez
  // de forzar el ejemplo de la doc — ver HALLAZGOS para el detalle.
  const officialExampleRequest: SupplierOrderRequest = {
    supplierId: "supplier_exel",
    supplierWarehouseId: "sw_gd",
    sameOrderId: "order_fake",
    warehouseShipmentId: "ws_fake",
    referenceId: "WC-FAKE",
    lines: [{ supplierSku: "NXPTIJAB016", quantity: 1 }],
    destination: {
      contactName: "Miguel Rios Martinez",
      email: "miguel.rm@xentra.mx",
      phone: "8718711854819", // 13 digitos -> lada "871" (primeros 3), telefono "8711854819" (ultimos 10)
      street: "Zaragoza",
      exteriorNumber: "454",
      neighborhood: "Centro",
      postalCode: "35150",
      country: "MX",
      notes: "Casa rosa con jardin",
    },
    shipping: {
      trackingNumber: "123456789",
      carrierName: "GPCL",
      labelBase64: "JVBERi0xLjUK...",
      labelFormat: "PDF",
    },
  }

  it("arma el payload exacto de /pedido a partir del request normalizado", () => {
    const payload = buildExelCreateOrderRequest(officialExampleRequest, "GD")

    expect(payload.clave_almacen).toEqual("GD")
    expect(payload.clave_transportista).toEqual("GPCL")
    expect(payload.orden_confirmada).toEqual(true)
    expect(payload.productos).toEqual([
      { clave_producto: "NXPTIJAB016", cantidad: 1 },
    ])
    expect(payload.direccion).toEqual({
      colonia: "Centro",
      codigo_postal: "35150",
      calle: "Zaragoza",
      numero_exterior: "454",
      numero_interior: "",
      referencias: "Casa rosa con jardin",
      contacto_nombre: "Miguel Rios Martinez",
      correo: "miguel.rm@xentra.mx",
      lada: "871",
      telefono: "8711854819",
    })
    expect(payload.envio).toEqual({
      guia: "123456789",
      base64pdf: "JVBERi0xLjUK...",
      num_orden: "WC-FAKE",
      formato: "PDF",
    })
  })

  it("parsea la respuesta exitosa documentada oficialmente (Numero_Orden)", () => {
    const officialExampleResponse = {
      resultado: {
        Numero_Orden: "903372777",
        Estatus: "r",
        Total: "30",
        correcto: 1,
        envio: "Guia de envio: REGISTRO INSERTADO",
      },
      mensaje: "",
      datos: "",
    }

    const result = parseExelCreateOrderResponse(200, officialExampleResponse)

    expect(result).toEqual({
      success: true,
      supplierOrderId: "903372777",
      rawStatus: "r",
    })
  })

  it("marca como retryable un HTTP distinto de 200/201", () => {
    const result = parseExelCreateOrderResponse(500, { mensaje: "Error interno" })
    expect(result.success).toEqual(false)
    expect(result.retryable).toEqual(true)
  })
})
