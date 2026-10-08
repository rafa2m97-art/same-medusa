import type { CheckoutGuardFailure } from "./taxonomy"

/**
 * Address Guard (plan §21/§22) — valida los campos NATIVOS de
 * `cart_address` (Medusa Cart module: `address_1`, `city`, `province`,
 * `postal_code`, `country_code`, `phone`). Deliberadamente NO modela
 * "colonia"/"número exterior" como campos propios todavía: Medusa no los
 * tiene de forma nativa (confirmado leyendo
 * node_modules/@medusajs/cart/dist/models/address.js -- el modelo real
 * de Medusa usa el mismo par genérico address_1/address_2 que
 * WooCommerce), y el código real de producción
 * (envia-shipping.php::create_format_request) de hecho REUTILIZA
 * `address_2` tanto para "number" como (con fallback) para "district" --
 * un conflicto real de modelado en el sistema actual, no una limitación
 * que haya que imitar. Introducir campos propios de "colonia"/"número"
 * se evalúa en Etapa 8, cuando Envia se integre de verdad y haya un caso
 * de uso concreto que lo justifique (plan §22: "no contaminar el
 * dominio" aplica en ambas direcciones -- tampoco inventar estructura
 * sin necesidad real todavía).
 *
 * Mínimos requeridos, evidencia real (SSH 2026-10-03):
 *   - WooCommerce core (`class-wc-countries.php`): `address_1`, `city`,
 *     `state`, `postcode`, `country` son `required => true` sin
 *     excepción para México; `phone` es requerido SEGÚN configuración de
 *     la tienda (`get_phone_field_visibility()`), nunca hardcodeado.
 *   - Envia (`envia-shipping.php::get_shipping_rates`, comentario real:
 *     "postalCode and state are required") -- confirma independientemente
 *     que sin postal code ni estado ni completos no se intenta ni
 *     cotizar.
 */

export interface AddressCompletenessInput {
  address1: string | null
  city: string | null
  province: string | null
  postalCode: string | null
  countryCode: string | null
  phone: string | null
}

export interface AddressGuardOptions {
  /** Default true -- refleja el default real de WooCommerce; una tienda podría desactivarlo, nunca se hardcodea sin opción. */
  phoneRequired?: boolean
}

export type AddressGuardResult =
  | { valid: true }
  | { valid: false; failure: CheckoutGuardFailure }

function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0
}

export function evaluateAddressCompleteness(
  input: AddressCompletenessInput,
  options: AddressGuardOptions = {}
): AddressGuardResult {
  const phoneRequired = options.phoneRequired ?? true
  const missingFields: string[] = []

  if (isBlank(input.address1)) missingFields.push("address1")
  if (isBlank(input.city)) missingFields.push("city")
  if (isBlank(input.province)) missingFields.push("province")
  if (isBlank(input.postalCode)) missingFields.push("postalCode")
  if (isBlank(input.countryCode)) missingFields.push("countryCode")
  if (phoneRequired && isBlank(input.phone)) missingFields.push("phone")

  if (missingFields.length > 0) {
    return {
      valid: false,
      failure: {
        failureCode: "ADDRESS_INCOMPLETE",
        failureStage: "ADDRESS_GUARD",
        details: { missingFields },
      },
    }
  }

  return { valid: true }
}
