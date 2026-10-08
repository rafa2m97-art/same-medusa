import * as fs from "fs"
import * as path from "path"
import { EnviaAdapter } from "../envia-adapter"

/**
 * Guard estructural (plan Etapa 8, cierre §2): "no lo llamamos" no es
 * suficiente -- esta suite comprueba que la CAPACIDAD de comprar/
 * generar una guía NO EXISTE en ningún punto alcanzable desde Etapa 8,
 * nunca que simplemente nadie la invoque hoy. Si alguien agregara
 * accidentalmente un método `purchaseLabel`/`createShipment` a
 * `EnviaAdapter`, o lo agregara al contrato `ShippingRateProvider`, o
 * lo llamara desde `plan-and-quote-shipping.ts`, estos tests fallan.
 *
 * Resultado conceptual verificado:
 *   Rate/Quote API      -> ✅ (getRates existe, es la única capacidad)
 *   Label Purchase       -> ❌ (no existe el método, no existe la ruta,
 *                               no existe el string del endpoint)
 */

const LABEL_PURCHASE_PATTERN = /purchaseLabel|buyLabel|generateLabel|createShipment|createLabel|\/ship\/generate|\/ship\/create/i

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf-8")
}

describe("Etapa 8 — guard estructural: Label Purchase fuera de alcance", () => {
  it("EnviaAdapter expone getRates como su única capacidad de cotización -- ningún método (público o privado) de compra de guía", () => {
    const adapter = new EnviaAdapter({ apiKey: "irrelevant" })
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).filter(
      (name) => name !== "constructor" && typeof (adapter as any)[name] === "function"
    )
    expect(methodNames).toContain("getRates")
    for (const name of methodNames) {
      expect(name).not.toMatch(LABEL_PURCHASE_PATTERN)
    }
  })

  it("el código fuente de EnviaAdapter no contiene ningún string/método de compra de guía", () => {
    expect(readSource("envia-adapter.ts")).not.toMatch(LABEL_PURCHASE_PATTERN)
  })

  it("el código fuente de normalize.ts (Envia) no contiene ningún string/método de compra de guía", () => {
    expect(readSource("normalize.ts")).not.toMatch(LABEL_PURCHASE_PATTERN)
  })

  it("el código fuente de types.ts (Envia, formas crudas) no contiene ningún string/método de compra de guía", () => {
    expect(readSource("types.ts")).not.toMatch(LABEL_PURCHASE_PATTERN)
  })

  it("el contrato normalizado ShippingRateProvider (package-planning/types.ts) no declara ninguna capacidad de compra de guía", () => {
    const contractSource = fs.readFileSync(
      path.join(__dirname, "../../../../modules/package-planning/types.ts"),
      "utf-8"
    )
    expect(contractSource).not.toMatch(LABEL_PURCHASE_PATTERN)
    // El contrato declara exactamente una capacidad.
    const methodMatches = contractSource.match(/^\s*\w+\(.*\):\s*Promise</gm) ?? []
    expect(methodMatches).toHaveLength(1)
    expect(methodMatches[0]).toMatch(/getRates/)
  })

  it("el workflow de Package Planning (plan-and-quote-shipping.ts) no contiene ningún string/método de compra de guía", () => {
    const workflowSource = fs.readFileSync(
      path.join(__dirname, "../../../../modules/package-planning/workflows/plan-and-quote-shipping.ts"),
      "utf-8"
    )
    expect(workflowSource).not.toMatch(LABEL_PURCHASE_PATTERN)
  })

  it("ningún endpoint fuera de /ship/rate/ es alcanzable desde el código de integración de Envia", () => {
    const adapterSource = readSource("envia-adapter.ts")
    const endpointMatches = adapterSource.match(/\/ship\/[a-zA-Z/]*/g) ?? []
    expect(new Set(endpointMatches)).toEqual(new Set(["/ship/rate/"]))
  })

  /**
   * Dirección inversa (plan Etapa 9 §34, cierre): Etapa 8 no existía
   * cuando `ShippingLabelProvider` (Etapa 9) se creó -- este test
   * confirma que ningún archivo de Etapa 8 (package-planning,
   * incl. este propio adapter de rate) importa esa capacidad nueva. Las
   * dos etapas comparten solo tipos YA normalizados
   * (`ShippingRateAddress`/`ShippingRatePackageInput`), nunca la
   * capacidad de comprar guía en sí.
   */
  it("ningún archivo de package-planning ni del adapter de rates de Envia importa ShippingLabelProvider (Etapa 9)", () => {
    const packagePlanningDir = path.join(__dirname, "../../../../modules/package-planning")
    const filesToCheck = [
      path.join(packagePlanningDir, "types.ts"),
      path.join(packagePlanningDir, "shipping-rate-provider-registry.ts"),
      path.join(packagePlanningDir, "workflows/plan-and-quote-shipping.ts"),
      readSourcePath("envia-adapter.ts"),
      readSourcePath("normalize.ts"),
    ]
    for (const filePath of filesToCheck) {
      if (!fs.existsSync(filePath)) continue
      const source = fs.readFileSync(filePath, "utf-8")
      expect(source).not.toMatch(/ShippingLabelProvider|SHIPPING_LABEL_PROVIDER|supplier-fulfillment/)
    }
  })
})

function readSourcePath(relativePath: string): string {
  return path.join(__dirname, "..", relativePath)
}
