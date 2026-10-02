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
  `/home/rmontanez97/Escritorio/TIENDA_SAME/same-pay-reference/typescript-port/` — se
  mueve aquí envuelto como Medusa Payment Provider Module.
- `fulfillment/envia/` — Etapa 8. Cliente TypeScript de Envia (pendiente de construir),
  envuelto como Medusa Fulfillment Provider Module.

Nada en esta carpeta debe usar credenciales reales todavía (Etapa 1-9 trabajan con
fixtures/sandbox). Ver plan completo:
`/home/rmontanez97/.claude/plans/tengo-una-idea-loca-bubbly-kahan.md`.
