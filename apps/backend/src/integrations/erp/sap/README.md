# SAP (ERP) — preparación de la Etapa 11

**Estado actual: carpeta placeholder. Sin código, sin conexión, sin credenciales.**
Ver el plan completo, sección "15. ERP/SAP — integración externa (preparación)":
`README.md (raíz del repositorio; roadmap resumido, plan detallado externo no incluido)`.

## Qué va a vivir aquí (cuando llegue la Etapa 11)

`SAPAdapter` — la implementación concreta de `ERPAdapter` (contrato normalizado que
vivirá en `src/modules/erp-sync/`), igual que `ExelAdapter` implementa `SupplierAdapter`
en `src/integrations/suppliers/exel/`. El dominio de SAME nunca conoce vocabulario de
SAP (DocEntry, DocNum, Service Layer, etc.) — eso vive exclusivamente aquí.

## Por qué está vacía todavía

No se asume todavía qué producto/versión de SAP usa SAME, ni qué documento(s) debe
generar una venta del ecommerce, ni qué interfaz oficial (Service Layer / DI API /
equivalente) está habilitada. Eso se investiga **on-site**, dentro de la red de SAME
(discovery read-only primero, luego pruebas controladas en TEST/QA) — ver plan §15.14.
Escribir un adapter antes de esas respuestas sería repetir el error que ya se corrigió
con Exel en Etapa 2-3: inventar reglas en vez de verificarlas contra el sistema real.

## Reglas duras (válidas desde ahora, no solo cuando se implemente)

- **Nunca** escritura directa a tablas SQL internas de SAP — solo la interfaz oficial
  soportada por la instalación real (a confirmar on-site). SQL Server es solo
  READ ONLY: investigación, consultas, validación, conciliación, reportes.
- **Nunca** credenciales reales en este repo — ni en código, ni en `.env.template`
  (solo placeholders ahí), ni en fixtures, ni en logs. Los valores reales se
  configuran únicamente on-site/local, nunca en git.
- **Nunca** escribir directo a `Order` de Medusa con campos de SAP en `metadata` — la
  relación vive en `ERPDocumentLink` (`src/modules/erp-sync/`), explícita y auditable,
  1 Order → N `ERPDocumentLink` (un documento puede encadenar Sales Order → Delivery →
  Invoice, cada uno con su propio estado/idempotencia).
- Idempotencia estricta: un retry de red nunca debe poder crear un segundo documento
  SAP para la misma operación.
- Un fallo de SAP nunca invalida ni destruye la Order de Medusa — Medusa conserva su
  historia completa; solo el `ERPDocumentLink` queda en estado de reintento o revisión
  manual.

## Lo que sí se puede construir desde casa antes del viaje on-site (Etapa 11A)

Contratos TypeScript (`ERPAdapter` y sus capacidades), el modelo `ERPDocumentLink` y su
máquina de estados, la lógica de idempotencia, un `FakeERPAdapter` para pruebas,
workflows, tests, fixtures sintéticos, eventos de auditoría (`ERP_SYNC_STARTED`,
`ERP_DOCUMENT_CREATED`, `ERP_DOCUMENT_FOUND_EXISTING`, `ERP_SYNC_COMPLETED`,
`ERP_SYNC_FAILED`, `ERP_MANUAL_REVIEW_REQUIRED`) y el flujo de intervención manual — sin
depender de la red de SAME. No se adelanta todavía (decisión explícita 2026-10-03,
Etapa 5 — Pricing es el siguiente paso).
