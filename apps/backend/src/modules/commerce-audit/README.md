# commerce-audit (contrato compartido, sin módulo Medusa real todavía)

`events.ts` define `CommerceAuditEvent`/`CommerceAuditEmitter` y los emisores
`InMemoryCommerceAuditEmitter`/`NoopCommerceAuditEmitter` — preparado desde Etapa 3
(reconciliación) y usado también por Etapa 4 (Inventory) y Etapa 5 (Pricing).

**No es un Module de Medusa real todavía** (no hay `Module()`, no hay modelos, no está
registrado en `medusa-config.ts`) — por eso vive aquí sin tabla propia. Cuando se
construya el módulo `commerce-audit` real (ver plan, tabla de Etapas), este archivo se
reemplaza por una implementación que escriba `CommerceAuditEvent` persistido; ningún
código de Supplier/Inventory/Pricing necesita cambiar porque ya dependen solo de la
interfaz `CommerceAuditEmitter`, inyectada por contenedor DI (`resolveCommerceAuditEmitter`,
lección de Etapa 4: nunca por `input` de workflow — el motor de Workflows serializa el
input entre steps y una instancia de clase pierde sus métodos).

Se movió aquí desde `modules/supplier/reconciliation/` (Etapa 5, 2026-10-03) porque ya
no es exclusivo de Supplier — Pricing lo usa igual.
