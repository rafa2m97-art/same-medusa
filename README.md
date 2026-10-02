# same-medusa

Backend headless de SAME Tienda sobre Medusa.js v2, migrando desde WooCommerce. Ver el
plan completo (arquitectura, decisiones, Etapas 1-12):
`/home/rmontanez97/.claude/plans/tengo-una-idea-loca-bubbly-kahan.md`.

**Estado actual: Etapa 1 (Foundation) completa.** Solo infraestructura base — sin lógica
de dominio todavía (eso empieza en la Etapa 2). Nada aquí usa credenciales reales de
Exel, Envia o MITEC, y nada está conectado a producción ni al VPS.

## Prerrequisitos

- Node.js v22+ (probado con v24.21.0)
- Docker Engine + plugin Compose (`docker compose version` debe funcionar)
- npm (el `packageManager` fijado en `package.json`; no usar pnpm/yarn aquí pese a lo que
  diga cualquier plantilla genérica de Medusa)

## Levantar el entorno desde cero

```bash
# 1. Instalar dependencias
npm install

# 2. Levantar Postgres + Redis locales (Docker)
npm run infra:up
npm run infra:status   # confirmar que ambos digan "healthy"

# 3. Configurar variables de entorno del backend
cp apps/backend/.env.template apps/backend/.env
# Editar apps/backend/.env:
#   - DATABASE_URL  -> usar el POSTGRES_USER/PASSWORD/DB de infra/local/.env
#   - REDIS_URL     -> redis://:<REDIS_PASSWORD de infra/local/.env>@127.0.0.1:6379
#   - JWT_SECRET / COOKIE_SECRET -> generar valores propios, nunca dejar el placeholder

# 4. Migraciones (esquema + datos semilla) — funciona desde una BD completamente vacía
npm run backend:migrate

# 5. Crear usuario admin
cd apps/backend && npx medusa user -e tu@correo.com -p 'TuPasswordFuerte123'

# 6. Levantar el backend en modo desarrollo
cd ../.. && npm run backend:dev
```

Verificar que quedó sano:

```bash
curl http://localhost:9000/health   # debe responder 200
# Panel admin: http://localhost:9000/app
```

## Apagar / resetear

```bash
npm run infra:down     # apaga Postgres/Redis, conserva los datos (volúmenes)
npm run infra:reset    # apaga y BORRA los datos (vuelve a una BD vacía) — úsalo con cuidado
npm run infra:logs     # logs en vivo de Postgres/Redis
```

## Tests

```bash
cd apps/backend
npm run test:unit                  # src/**/__tests__/**/*.unit.spec.ts
npm run test:integration:modules   # src/modules/*/__tests__/**  (vacío hasta Etapa 2)
npm run test:integration:http      # integration-tests/http/*.spec.ts  (vacío hasta Etapa 2+)
```

`test:unit` ya tiene una prueba de humo (`src/__tests__/foundation.unit.spec.ts`) que
confirma que el runner de tests funciona y que las variables de entorno críticas cargan.

## Estructura (alineada con la arquitectura aprobada)

```
same-medusa/
├── apps/
│   └── backend/
│       └── src/
│           ├── modules/        # DOMINIO genérico — nunca referencia un proveedor concreto
│           ├── integrations/   # Implementaciones concretas (Exel, MITEC, Envia)
│           ├── workflows/
│           ├── subscribers/
│           ├── jobs/
│           └── scripts/
└── infra/
    └── local/                  # docker-compose.yml de Postgres+Redis para desarrollo local
```

Ver `apps/backend/src/modules/PLANNED_MODULES.md` y `apps/backend/src/integrations/README.md`
para el detalle de qué va en cada carpeta y en qué Etapa se construye.

## Diferencias con el entorno del VPS (staging)

Ver `same-medusa-infra/INFRA.md` (en el directorio padre) para el setup del VPS. Diferencias
deliberadas de este entorno local:

| | Local | VPS (staging) |
|---|---|---|
| Medusa | corre nativo (`npm run dev`), sin Docker | corre dentro de Docker (imagen propia vía Dockerfile) |
| Postgres/Redis | Docker, mismas imágenes (`postgres:16-alpine`, `redis:7-alpine`) | Docker, mismas imágenes |
| Puertos publicados | Postgres `5432`, Redis `6379` (ambos en `127.0.0.1`, hacen falta para que el Medusa nativo del host los alcance) | Postgres `5433`→`5432` (debug manual), Redis sin publicar (solo red interna de Docker, ya que Medusa también está en esa red) |
| NODE_ENV | `development` | `development` temporalmente (pendiente volver a `production` cuando haya TLS real — ver `INFRA.md`) |
| Secretos | generados para esta máquina, sin relación con los del VPS | generados para el VPS, sin relación con los de local |
| Proveedores | Exel vía fixtures, Envia/MITEC en sandbox | Exel en `capture-only`/`dry-run`, Envia/MITEC en sandbox/QA |

El VPS **no es el entorno primario de desarrollo** — todo el trabajo de dominio (Etapas
2-11) se construye y prueba aquí en local primero.
