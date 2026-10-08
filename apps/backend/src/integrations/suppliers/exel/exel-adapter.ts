import type {
  AllocationLineToConfirm,
  LiveConfirmationResult,
  NormalizedCatalogTotal,
  NormalizedSupplierProduct,
  NormalizedWarehouseStock,
  RetryPolicy,
  SupplierAdapter,
  SupplierCatalogAdapter,
  SupplierInventoryAdapter,
  SupplierOrderAdapter,
  SupplierOrderRequest,
  SupplierOrderResult,
  SupplierPricingAdapter,
  SupplierWarehouseDescriptor,
} from "../../../modules/supplier/types"
import type {
  ExelAlmacenesResponse,
  ExelCreateOrderResponse,
  ExelProductosAlmacenesResponse,
  ExelProductosResponse,
} from "./types"
import {
  buildExelCreateOrderRequest,
  normalizeExelCatalogTotal,
  normalizeExelProduct,
  normalizeExelWarehouse,
  normalizeExelWarehouseStock,
  parseExelCreateOrderResponse,
} from "./normalize"
import { ExelPricingAdapter } from "./exel-pricing"

const EXEL_BASE_URL = "https://api01.exeldelnorte.com.mx"

export interface ExelAdapterConfig {
  apiKey: string
  baseUrl?: string
}

/**
 * ADVERTENCIA (Etapa 2): esta clase SÍ implementa las llamadas HTTP reales
 * a Exel (para que la Etapa 3 solo tenga que "encenderlas"), pero esta
 * etapa explícitamente NO debe invocarlas contra la Exel real — ningún
 * test de esta etapa llama fetchFullCatalog()/fetchStockByWarehouse()/
 * submitFulfillmentOrder() de verdad. Los tests usan las funciones puras
 * de normalize.ts directamente contra fixtures. No se usa ninguna API key
 * real en esta etapa.
 */
class ExelCatalogAdapterImpl implements SupplierCatalogAdapter {
  constructor(private config: ExelAdapterConfig) {}

  async fetchFullCatalog(): Promise<NormalizedSupplierProduct[]> {
    const url = `${this.config.baseUrl || EXEL_BASE_URL}/productos?sin_stock=true`
    const res = await fetch(url, {
      headers: { Authorization: this.config.apiKey },
    })
    const data = (await res.json()) as ExelProductosResponse
    return (data.datos || []).map(normalizeExelProduct)
  }
}

class ExelInventoryAdapterImpl implements SupplierInventoryAdapter {
  constructor(private config: ExelAdapterConfig) {}

  async listWarehouses(): Promise<SupplierWarehouseDescriptor[]> {
    const url = `${this.config.baseUrl || EXEL_BASE_URL}/almacenes`
    const res = await fetch(url, {
      headers: { Authorization: this.config.apiKey },
    })
    const data = (await res.json()) as ExelAlmacenesResponse
    return (data.datos || []).map(normalizeExelWarehouse)
  }

  async fetchStockByWarehouse(): Promise<NormalizedWarehouseStock[]> {
    // Documentado como POST /productos_almacenes con body {"skus": [...]}
    // (máx. 100). El sistema real en producción nunca usó ese filtro — ver
    // nota en types.ts. Esta implementación usa el GET plano (igual que
    // producción) por ahora; cambiar a batches de 100 SKUs vía POST es
    // una optimización real pendiente para Etapa 3, no una limitación de
    // este contrato.
    const url = `${this.config.baseUrl || EXEL_BASE_URL}/productos_almacenes`
    const res = await fetch(url, {
      headers: { Authorization: this.config.apiKey },
    })
    const data = (await res.json()) as ExelProductosAlmacenesResponse
    return (data.datos || []).flatMap(normalizeExelWarehouseStock)
  }

  async fetchCatalogTotals(): Promise<NormalizedCatalogTotal[]> {
    const url = `${this.config.baseUrl || EXEL_BASE_URL}/productos?sin_stock=true`
    const res = await fetch(url, {
      headers: { Authorization: this.config.apiKey },
    })
    const data = (await res.json()) as ExelProductosResponse
    return (data.datos || []).map(normalizeExelCatalogTotal)
  }

  async confirmAllocationLive(
    allocation: AllocationLineToConfirm[]
  ): Promise<LiveConfirmationResult> {
    // Exel no tiene un endpoint dedicado de "confirmar en vivo" — la
    // confirmación real hoy se hace releyendo /productos_almacenes justo
    // antes de pagar (ver MSL_Stock_Validation::check en el código real).
    // Se modela igual aquí: trae el stock fresco y compara contra lo
    // solicitado. No implementado como llamada real en esta etapa.
    const stock = await this.fetchStockByWarehouse()
    const byKey = new Map(
      stock.map((s) => [`${s.warehouseExternalCode}:${s.supplierSku}`, s.quantity])
    )
    for (const line of allocation) {
      const available = byKey.get(`${line.warehouseExternalCode}:${line.supplierSku}`) ?? 0
      if (available < line.quantity) {
        return {
          confirmed: false,
          status: "REJECTED",
          reason: `Stock insuficiente para ${line.supplierSku} en ${line.warehouseExternalCode}`,
        }
      }
    }
    return { confirmed: true, status: "CONFIRMED" }
  }
}

class ExelOrderAdapterImpl implements SupplierOrderAdapter {
  constructor(private config: ExelAdapterConfig) {}

  async submitFulfillmentOrder(
    req: SupplierOrderRequest
  ): Promise<SupplierOrderResult> {
    // req representa el fulfillment de UN solo almacén (ver nota de
    // "un pedido Exel por almacén" en modules/supplier/types.ts). El
    // código de almacén real a usar en clave_almacen viene de
    // externalReferences.warehouseExternalCode — lo resuelve quien llama
    // (el WarehouseShipment conoce su SupplierWarehouse, el adapter no
    // debe tener que volver a buscarlo).
    const warehouseExternalCode = req.externalReferences?.warehouseExternalCode
    if (!warehouseExternalCode) {
      return {
        success: false,
        error: "Falta externalReferences.warehouseExternalCode en el request normalizado",
        retryable: false,
      }
    }

    const payload = buildExelCreateOrderRequest(req, warehouseExternalCode)
    const url = `${this.config.baseUrl || EXEL_BASE_URL}/pedido`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    const data = (await res.json().catch(() => null)) as ExelCreateOrderResponse | null
    return parseExelCreateOrderResponse(res.status, data)
  }

  getRetryPolicy(): RetryPolicy {
    // Igual que el comportamiento real hoy (handle_send_failure,
    // verificado por SSH 2026-10-06 contra class-msl-exel-api.php): 3
    // intentos, backoff fijo 5/15/60 min. Exel no documenta códigos de
    // error retryable/non-retryable — la única no-retryable real hoy es
    // un error de CONFIGURACIÓN local (ej. falta clave de producto,
    // `_msl_exel_config_error` real), no algo que Exel devuelva.
    return {
      maxAttempts: 3,
      backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
      nonRetryableErrorCodes: ["local_config_error"],
    }
  }
}

export class ExelAdapter implements SupplierAdapter {
  readonly supplierCode = "exel_del_norte"
  catalog: SupplierCatalogAdapter
  inventory: SupplierInventoryAdapter
  pricing: SupplierPricingAdapter
  order: SupplierOrderAdapter

  constructor(config: ExelAdapterConfig) {
    this.catalog = new ExelCatalogAdapterImpl(config)
    this.inventory = new ExelInventoryAdapterImpl(config)
    this.pricing = new ExelPricingAdapter()
    this.order = new ExelOrderAdapterImpl(config)
  }
}
