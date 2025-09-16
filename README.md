AI Orchestrator (Fastify + TypeScript + Prisma + PostgreSQL)

## Requisitos
- Node.js 18+
- PostgreSQL 13+

## Configuración
1. Copia `.env.example` a `.env` y completa variables.
2. Instala dependencias:
```bash
npm i
```
3. Define tu `DATABASE_URL` con Postgres en `.env`, por ejemplo:
```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/ai_orchestrator?schema=public"
```
4. Genera cliente Prisma y migra DB:
```bash
npm run generate
npm run migrate
```
5. Ejecuta en desarrollo:
```bash
npm run dev
```

## Endpoints
- POST `/tenants/register`  -> Crea tenant y devuelve `apikey`.
- POST `/ai/answer` -> Requiere header `x-api-key`.

### Ejemplo de request a /ai/answer
```bash
curl -X POST http://localhost:3000/ai/answer \
  -H "content-type: application/json" \
  -H "x-api-key: TU_API_KEY" \
  -d '{
    "system": { "prompt": "Eres un asistente útil", "policies": { "temperature": 0.2, "max_tokens": 200 } },
    "conversation": [ { "role": "user", "content": "Hola, ¿puedes resumir esto?" } ],
    "mcp_servers": [
      { "name": "tools", "url": "http://localhost:4000", "headers": {"authorization": "Bearer token"} }
    ],
    "model": "gpt-4.1-mini"
  }'
```

## Notas
- El costo se calcula con una estimación simple de tokens (aprox 4 chars/token).
- Ajusta precios en tabla `models`.
- Cambia proveedor o modelo cargando más filas en `models`.


