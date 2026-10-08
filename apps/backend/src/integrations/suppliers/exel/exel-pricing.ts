import type { SupplierPricingAdapter } from "../../../modules/supplier/types"

/**
 * Fórmula real confirmada (idéntica en /opt/exel_sync/same_product_contract.py
 * y en class-msl-exel-shipping.php para costo de envío): margen de 5% +
 * IVA 16%, redondeado hacia arriba al PESO ENTERO (no al centavo).
 *
 *   precio_final = ceil((precio_exel / 0.95) * 1.16)
 *
 * El resultado es TAX-INCLUSIVE (ya incluye el IVA) — ver plan, sección
 * "Precios — tax-inclusive". No implementado aquí todavía como regla de
 * negocio completa (eso es Etapa 5); esto solo demuestra que el contrato
 * SupplierPricingAdapter es suficiente para expresarla sin contaminar el
 * dominio con la fórmula de Exel (un proveedor futuro puede tener otro
 * margen y otra tasa de impuesto).
 */
export class ExelPricingAdapter implements SupplierPricingAdapter {
  private static readonly MARGIN_FACTOR = 0.95
  private static readonly IVA_FACTOR = 1.16

  computePublicPrice(costPrice: number, _currency: string): number {
    const withMargin = costPrice / ExelPricingAdapter.MARGIN_FACTOR
    const withTax = withMargin * ExelPricingAdapter.IVA_FACTOR
    // ceil() al peso entero, no al centavo — así es la fórmula real
    // (confirmado con el ejemplo: costo 100 -> 123, no 122.11).
    return Math.ceil(withTax)
  }
}
