-- Script para actualizar la configuración de GPT-5 a valores rápidos
-- Ejecutar este script para todos los tenants que usan GPT-5

-- Actualizar todos los settings que no tienen configuración de GPT-5
UPDATE "settings"
SET gpt5_reasoning_effort = 'low'
WHERE gpt5_reasoning_effort IS NULL;

-- Verificar los cambios
SELECT 
  tenant_id, 
  model_default,
  gpt5_reasoning_effort
FROM "settings";

-- Si quieres cambiar a un tenant específico:
-- UPDATE "settings"
-- SET gpt5_reasoning_effort = 'low'
-- WHERE tenant_id = 'tu_tenant_id_aqui';

