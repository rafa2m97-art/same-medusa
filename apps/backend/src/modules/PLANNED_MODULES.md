# Módulos de dominio planeados (SAME Tienda)

Ver el plan completo: `/home/rmontanez97/.claude/plans/tengo-una-idea-loca-bubbly-kahan.md`,
sección "Arquitectura de negocio en Medusa — v2, revisada". Esta carpeta (`src/modules/`)
es DOMINIO genérico — nunca debe referenciar un proveedor concreto (Exel, MITEC, Envia).
Las implementaciones concretas de proveedores viven en `src/integrations/`.

Construidos en este repo todavía: **ninguno** (Etapa 1 = foundation, sin lógica de
dominio aún). Cada uno de abajo se construye en su Etapa correspondiente (ver tabla de
Etapas 1-12 del plan).

| Módulo | Etapa | Contenido |
|---|---|---|
| `supplier/` | 2 | `Supplier`, `SupplierWarehouse`, `SupplierProductMapping` (incluye campos de cuarentena), `SyncRun`, `SyncConflict` |
| `brand/` | 2 (o cuando se necesite) | Marca de producto — Medusa no tiene esto nativo |
| `pricing-rules/` | 5 | `SupplierCost` (costo crudo, nunca expuesto como `Price` público) + fórmula de margen |
| `warehouse-routing/` | 6 | `allocate-cart.ts`, `AllocationSnapshot`, `RoutingRule` (tabla + lat/lng real) |
| `package-planning/` | 8 | bin-packing, `PackingRule`, `PackagePlan`, `carrier-limits.ts` |
| `supplier-fulfillment/` | 9 | `WarehouseShipment` (módulo dedicado, máquina de estados por almacén) |
| `commerce-audit/` | 8-9 (según se necesite) | `CommerceAuditEvent` |
| `app-settings/` | cuando haya primer setting real editable | configuración + audit log, secretos NUNCA aquí |
| `seo-redirects/` | 11 (import de WooCommerce) | `UrlRedirect` |

`product-specs/` queda diferido (ver plan §1) — no construir sin caso de uso real.
