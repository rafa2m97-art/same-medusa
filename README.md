# same-medusa

Backend headless de SAME sobre Medusa.js **2.21.2**, TypeScript, Postgres 16 y
Redis 7. Migración progresiva (strangler) desde WooCommerce, que continúa como
sistema actual. Backend estable hasta **Etapa 9**; frontend Next.js 15 previsto.

El dominio custom es genérico y admite múltiples proveedores y almacenes. Los
adapters normalizan datos externos; inventory, pricing, routing y fulfillment
conservan Last Known Good, idempotencia y auditoría. Exel es el proveedor actual;
Syscom está contemplado, sin integración. Pricing source y fulfillment son independientes.

## Local Development Setup

Requisitos: Node.js >=22.22.0 (probado con 24.21.0), npm **11.19.0**, Docker Engine
con Compose. Ejecutar desde la raíz del repositorio salvo indicación contraria.
El repo contiene backend únicamente. Cada computadora genera sus propios secretos
locales; datos Docker, credenciales y labels generadas no se comparten por Git.

```bash
# Sustituir el marcador por la URL de GitHub confirmada; todavía no hay remote.
git clone <GitHub-repository-URL> same-medusa
cd same-medusa
git checkout dev

cp infra/local/.env.template infra/local/.env
cp apps/backend/.env.template apps/backend/.env
cp apps/backend/.env.test.template apps/backend/.env.test
```

Editar las tres copias locales antes de continuar:

- En `infra/local/.env`, configurar `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` y `REDIS_PASSWORD`.
- En `apps/backend/.env`, alinear `DATABASE_URL` y `REDIS_URL` con esas
  credenciales y generar valores propios para `JWT_SECRET` y `COOKIE_SECRET`.
  Codificar caracteres especiales en usuario/password de las URLs.
- En `apps/backend/.env.test`, alinear `DB_USERNAME` y `DB_PASSWORD` con Postgres
  local. `DB_HOST=127.0.0.1` y `DB_PORT=5432`. El runner crea y elimina bases
  temporales; usar exclusivamente esta infraestructura local de desarrollo.
- Tests usan fixtures/fakes: no requieren credenciales reales de Exel o Envia.
  Mantener los candados Envia en `false` y el entorno en sandbox. Las variables
  de proveedores documentan los adapters existentes; bootstrap no llama sus APIs.

```bash
npm ci
npm run infra:up
npm run infra:status             # Postgres y Redis deben estar healthy
npm run backend:migrate         # migrations y datos iniciales en la BD local
npm run backend:dev              # backend :9000; admin /app
```

Opcional: crear un usuario admin local en otra terminal:

```bash
cd apps/backend
npx --no-install medusa user -e tu@correo.com -p '<local-admin-password>'
```

Pruebas y validaciones (Postgres local debe estar disponible):

```bash
# Desde la raíz
cd apps/backend
npm run test:unit
npm run test:integration:modules
npm run test:integration:http
npx --no-install tsc --noEmit
cd ../..
npx --no-install eslint apps/backend
```

El glob de módulos también ejecuta parte de las unitarias. Baseline: 313 unitarias,
255 pruebas en el glob de módulos (19 propias + 236 unitarias repetidas), 137 HTTP:
**469 pruebas únicas**. ESLint conserva 4 warnings preexistentes, 0 errores.

```bash
# Desde la raíz; conserva los volúmenes locales
npm run infra:down
# Diagnóstico local
npm run infra:logs
```

`npm run infra:reset` existe, pero **borra los volúmenes locales**. No forma parte
del bootstrap habitual. Migrations están versionadas; datos runtime no.

## Backend Roadmap

| Etapa | Estado |
|---|---|
| 1. Foundation | ✅ |
| 2. Supplier Domain | ✅ |
| 3. Reconciliation | ✅ |
| 4. Inventory | ✅ |
| 5. Pricing | ✅ |
| 5.1 Multi-Supplier Pricing Source | ✅ |
| 6. Routing / Sourcing | ✅ |
| 7. Checkout Guards | ✅ |
| 8. Package Planning + Envia Quotes | ✅ |
| 9. WarehouseShipment / Supplier Fulfillment | ✅ |
| 10. MITEC / Payments | ⏳ |
| 11. ERP / SAP Integration | ⏳ |
| 12. WooCommerce Data Migration & Cutover Preparation | ⏳ |
| 13. Staging / VPS / Rollout | ⏳ |

El plan detallado y referencias históricas externas no forman parte del repo y
no son necesarios para arrancar. No se implementa Etapa 10 en esta preparación.

## Branch strategy

- `master`: baseline estable aprobado.
- `dev`: desarrollo e integración.
- `feature/*`: trabajo futuro aislado.

Flujo: `feature/* → dev → master`. Inicialmente `master`, `dev` y el tag anotado
`v0.9-backend` apuntan al mismo baseline de Etapa 9. No mover tags publicados.

```bash
git checkout dev
git checkout -b feature/<nombre>
```

Antes de integrar, ejecutar las validaciones anteriores. No versionar secretos,
dumps, dependencias, builds ni archivos runtime. Publicación en GitHub pendiente
de URL confirmada y autorización; no se realizó push durante la preparación.

## Estructura

```text
apps/backend/
  src/modules/          dominio, workflows, modelos y migrations
  src/integrations/     adapters concretos de proveedores
  src/links/            links de módulos
  integration-tests/    tests del backend completo
infra/local/            Docker Compose y plantilla de entorno local
```

Limitaciones existentes: EnviaLabelAdapter pendiente de validación de red real;
reconciliación ambigua Exel manual; cancelación externa sin integrar; operaciones
manuales sin capa admin/HTTP y actor todavía string libre. No se modifican aquí.
