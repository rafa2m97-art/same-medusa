# Integraciones (implementaciones concretas, intercambiables)

Esta carpeta implementa los contratos definidos en `src/modules/` (ej. `SupplierAdapter`,
`SupplierCatalogAdapter`, etc.) para un proveedor/servicio concreto. El dominio
(`src/modules/`) nunca importa nada de aquí directamente al revés — solo conoce las
interfaces; la implementación concreta se inyecta por configuración.

- `suppliers/exel/` — Etapa 2-3. Implementa `SupplierAdapter` para Exel del Norte:
  `exel-api-client.ts` (`GET /productos?sin_stock=true`, `GET /productos_almacenes`,
  `POST /pedido`, header `Authorization: <api_key_cruda>` sin "Bearer"),
  `exel-pricing.ts` (`ceil((cost/0.95)*1.16)`), `exel-reconciliation-rules.ts`
  (clasificación APPLY/QUARANTINE). Un futuro proveedor (CVA, CT, Ingram...) sería una
  carpeta hermana aquí, nunca un cambio al dominio.
- `payments/mitec/` — Etapa 10. El cliente TypeScript de MITEC ya está construido y
  verificado contra la red real en
  `same-pay-reference/typescript-port/ (referencia externa no incluida en este repositorio)` — se
  mueve aquí envuelto como Medusa Payment Provider Module.
- `fulfillment/envia/` — Etapa 8. Cliente TypeScript de Envia (pendiente de construir),
  envuelto como Medusa Fulfillment Provider Module.
- `erp/sap/` — Etapa 11 (preparación, 2026-10-03; sin implementar todavía). Futuro
  `SAPAdapter`, implementación concreta de `ERPAdapter`. Ver su propio README para las
  reglas duras (nunca SQL directo para escritura, nunca credenciales en el repo,
  subfase on-site separada para discovery antes de cualquier integración real).

Nada en esta carpeta debe usar credenciales reales todavía (Etapa 1-9 trabajan con
fixtures/sandbox; SAP ni siquiera se conecta hasta la Etapa 11, on-site). Ver plan
completo: `README.md (raíz del repositorio; roadmap resumido, plan detallado externo no incluido)`.
