import { MedusaService } from "@medusajs/framework/utils"
import CheckoutReadiness from "./models/checkout-readiness"
import ShippingQuote from "./models/shipping-quote"
import ShippingSelection from "./models/shipping-selection"
import LiveConfirmationCircuitState from "./models/live-confirmation-circuit-state"

class CheckoutGuardsModuleService extends MedusaService({
  CheckoutReadiness,
  ShippingQuote,
  ShippingSelection,
  LiveConfirmationCircuitState,
}) {}

export default CheckoutGuardsModuleService
