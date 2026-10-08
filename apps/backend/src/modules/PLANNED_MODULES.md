# Módulos de dominio planeados (SAME Tienda)

Ver el plan completo: `README.md (raíz del repositorio; roadmap resumido, plan detallado externo no incluido)`,
sección "Arquitectura de negocio en Medusa — v2, revisada". Esta carpeta (`src/modules/`)
es DOMINIO genérico — nunca debe referenciar un proveedor concreto/ERP (Exel, MITEC,
Envia, SAP). Las implementaciones concretas viven en `src/integrations/`.

Construidos en este repo (Etapas 1-4, aprobadas): **`supplier/`** — `Supplier`,
`SupplierWarehouse`, `SupplierProductMapping`, `SupplierProductState`, `SyncRun`,
`SyncConflict`, además de `reconciliation/` y `workflows/` dentro del mismo módulo
(Inventory de Etapa 4 no necesitó un módulo nuevo — reutiliza `StockLocation`/
`InventoryItem`/`InventoryLevel` nativos de Medusa).

| Módulo | Etapa | Contenido |
|---|---|---|
| `supplier/` | 2-4 ✅ | `Supplier`, `SupplierWarehouse`, `SupplierProductMapping`, `SupplierProductState`, `SyncRun`, `SyncConflict` + reconciliación + workflows de inventario |
| `brand/` | cuando se necesite | Marca de producto — Medusa no tiene esto nativo |
| `pricing-rules/` | 5 | `SupplierCost` (costo crudo, nunca expuesto como `Price` público) + fórmula de margen |
| `warehouse-routing/` | 6 | `allocate-cart.ts`, `AllocationSnapshot`, `RoutingRule` (tabla + lat/lng real) |
| `package-planning/` | 8 | bin-packing, `PackingRule`, `PackagePlan`, `carrier-limits.ts` |
| `supplier-fulfillment/` | 9 | `WarehouseShipment` (módulo dedicado, máquina de estados por almacén) |
| `commerce-audit/` | 8-9 (según se necesite) | `CommerceAuditEvent` — interfaz ya preparada desde Etapa 3/4 (`reconciliation/commerce-audit-events.ts`), módulo real todavía no construido |
| `erp-sync/` | 11 (preparación, ver plan §15; implementación en 11A) | `ERPDocumentLink` (1 Order → N links) + máquina de estados (`PENDING/SYNCING/SYNCED/FAILED_RETRYABLE/REQUIRES_MANUAL_REVIEW/CANCELLED`) + `ERPAdapter` normalizado — implementación concreta (`SAPAdapter`) en `src/integrations/erp/sap/` |
| `app-settings/` | cuando haya primer setting real editable | configuración + audit log, secretos NUNCA aquí |
| `seo-redirects/` | 12 (import de WooCommerce) | `UrlRedirect` |

`product-specs/` queda diferido (ver plan §1) — no construir sin caso de uso real.
