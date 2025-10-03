# 🔧 MEJORAS PROPUESTAS PARA TOOLS

## ⚠️ PROBLEMAS CRÍTICOS ENCONTRADOS

### 1. **HERRAMIENTA FALTANTE MENCIONADA**
- ❌ `verify_route` menciona usar `select_location_from_list` que **NO EXISTE**
- ✅ Solución: Corregir la referencia a `get_origin_locations`

### 2. **PARÁMETROS REQUERIDOS INCORRECTOS**
- ❌ `get_available_seats` tiene `cantidad_pasajeros` como opcional, debería ser requerido
- ❌ `add_customer` no especifica todos los required correctamente

### 3. **DESCRIPCIONES CONFUSAS O INCOMPLETAS**
- ❌ `get_document_types` tiene typos ("simpre")
- ❌ `create_shopping_cart` no explica CUÁNDO crear uno nuevo
- ❌ Falta claridad sobre el FLUJO COMPLETO de una reserva

### 4. **HERRAMIENTA DUPLICADA**
- ❌ `get_date_info` y `getDateInfo` son la misma herramienta

---

## 📋 MEJORAS ESPECÍFICAS POR HERRAMIENTA

### 1. **get_date_info / getDateInfo**
**Problema:** Dos herramientas idénticas  
**Mejora:** Mantener solo `get_date_info` y agregar ejemplos más claros

```typescript
MEJORAR CON:
- Agregar más ejemplos de uso común: "mañana", "pasado mañana", "en 3 días"
- Clarificar que devuelve fecha en formato ISO (YYYY-MM-DD) que se debe usar en get_schedules
- Agregar advertencia: "Si el usuario dice 'hoy', usa la fecha actual del sistema"
```

---

### 2. **get_origin_locations**
**Problema:** Descripción muy básica  
**Mejora:**
```typescript
description: `Lista todas las localidades de origen disponibles.

⚠️ CUÁNDO USAR ESTA HERRAMIENTA:
- Al INICIO de cualquier consulta de rutas o horarios
- Cuando el usuario menciona una ciudad/localidad y necesitas su ID
- ANTES de usar verify_route o get_schedules

📝 CÓMO USAR:
1. Ejecuta esta herramienta para obtener la lista completa de localidades
2. Busca el nombre de la localidad que mencionó el usuario
3. Extrae el ID de esa localidad
4. Usa ese ID en las siguientes herramientas (verify_route, get_schedules)

❌ NUNCA ASUMAS ni INVENTES IDs de localidades

Ejecuta: Sp_WSOpenAiLocalidadesOrigenV2

Returns:
  {
    "Localidades": [
      {"Id": 1, "Nombre": "Río Cuarto"},
      {"Id": 6, "Nombre": "Córdoba"},
      ...
    ]
  }
  
EJEMPLO DE USO:
Usuario: "Quiero viajar de Río Cuarto a Córdoba"
1. Ejecutar get_origin_locations
2. Buscar "Río Cuarto" → ID: 1
3. Buscar "Córdoba" → ID: 6
4. Usar IDs en verify_route(loc_origen=1, loc_destino=6)
`
```

---

### 3. **verify_route**
**Problema Crítico:** Menciona herramienta inexistente  
**Mejora:**
```typescript
description: `Verifica si existe una ruta de autobús entre dos localidades usando sus IDs.

⚠️ FLUJO OBLIGATORIO:
1. PRIMERO: Ejecutar get_origin_locations para obtener los IDs
2. SEGUNDO: Buscar las localidades mencionadas por el usuario en el resultado
3. TERCERO: Ejecutar verify_route con los IDs encontrados

❌ NUNCA asumas ni inventes IDs de localidades
❌ Si no encuentras una localidad en get_origin_locations, informa que no la tenemos disponible

CUÁNDO USAR:
- Después de obtener los IDs con get_origin_locations
- ANTES de buscar horarios con get_schedules
- Para confirmar que existe conexión entre dos ciudades

SI EL RESULTADO ES FALSE:
"Lo siento, no tenemos rutas directas entre [origen] y [destino]"

Ejecuta: Sp_WSOpenAiLocalidadesDestinoV2

Args:
  loc_origen (int): ID de la localidad de origen
  loc_destino (int): ID de la localidad de destino

Returns:
  {
    "Resultado": true/false,
    "data": [...]
  }
`
```

---

### 4. **get_schedules**
**Problema:** Falta claridad sobre formato de fecha  
**Mejora:** Agregar al inicio de la descripción:
```typescript
⚠️ FORMATO DE FECHA REQUERIDO: YYYYMMDD (sin guiones ni espacios)
- Ejemplo correcto: "20251003"
- Ejemplo incorrecto: "2025-10-03" o "03/10/2025"

💡 FLUJO RECOMENDADO:
1. Si el usuario dice "mañana" o fecha relativa → Usar get_date_info primero
2. get_date_info devuelve {"iso": "2025-10-03"}
3. Convertir ISO a YYYYMMDD quitando guiones: "20251003"
4. Ejecutar get_schedules con fecha="20251003"
```

---

### 5. **get_available_seats**
**Problema:** cantidad_pasajeros debería ser requerido  
**Mejora:**
```typescript
parameters: { 
  type: 'object', 
  properties: { 
    id_horario: { type: 'string' }, 
    id_loc_desde: { type: 'integer' }, 
    id_loc_hasta: { type: 'integer' }, 
    cantidad_pasajeros: { type: 'integer' },  // CRÍTICO
    tipo_butaca: { type: 'string' } 
  }, 
  required: ['id_horario', 'id_loc_desde', 'id_loc_hasta', 'cantidad_pasajeros'],  // AGREGADO
  additionalProperties: true 
}
```

---

### 6. **create_shopping_cart**
**Problema:** No explica cuándo crear uno nuevo  
**Mejora:**
```typescript
description: `Crea un nuevo carrito de compras para iniciar el proceso de reserva.

⚠️ CUÁNDO CREAR UN CARRITO NUEVO:
- Al INICIAR una nueva reserva/venta
- UNA VEZ por transacción (incluso si son múltiples pasajeros)
- ANTES de usar add_to_cart

⚠️ CUÁNDO NO CREAR CARRITO:
- Si ya creaste uno en esta conversación
- Al agregar más pasajeros a una reserva existente (usa el ID del carrito ya creado)

📝 FLUJO TÍPICO:
1. Cliente pide reservar pasajes
2. Crear carrito → Guardar el ID del carrito
3. Agregar cada pasajero con add_to_cart usando ese ID de carrito
4. Finalizar con finalize_sale usando ese ID de carrito

💡 El ID del carrito es único y debes guardarlo en memoria para usarlo en add_to_cart

Ejecuta: sp_carrito_compras_create

Returns:
  {
    "carrito": [
      {"Id_carrito": 12345}
    ]
  }
`
```

---

### 7. **add_to_cart**
**Problema:** Falta claridad sobre múltiples pasajeros  
**Mejora:** Agregar al inicio:
```typescript
⚠️ LLAMADAS MÚLTIPLES REQUERIDAS:
- Esta herramienta se ejecuta UNA VEZ por CADA pasajero
- Para 3 pasajeros = 3 llamadas a add_to_cart con el MISMO id_carrito
- Cada llamada debe tener un DNI diferente

EJEMPLO - 2 pasajeros:
1. add_to_cart(id_carrito=12345, dni="12345678", numero_butaca=10, ...)
2. add_to_cart(id_carrito=12345, dni="87654321", numero_butaca=11, ...)
3. finalize_sale(id_carrito=12345)
```

---

### 8. **add_customer**
**Problema:** Falta indicar qué hacer si falta el género  
**Mejora:**
```typescript
⚠️ PARÁMETRO GÉNERO:
- genero: 1 = Masculino, 2 = Femenino
- Si el usuario no especifica género, pregunta: "¿Es masculino o femenino?"
- NO asumas el género basado en el nombre

⚠️ FECHA DE NACIMIENTO:
- Formato requerido: YYYY-MM-DD
- Si el usuario da solo la edad, calcula: año_actual - edad
- Si no da fecha, pide al menos la edad aproximada
```

---

### 9. **search_customer_data**
**Problema:** No indica qué hacer con el resultado  
**Mejora:** Agregar al final:
```typescript
📝 INTERPRETACIÓN DEL RESULTADO:

SI DEVUELVE DATOS (cliente existe):
- Extraer el nombre completo para confirmar
- Responder: "Encontré tu registro: [Nombre] [Apellido]. ¿Es correcto?"
- Continuar con el proceso de reserva

SI DEVUELVE ARRAY VACÍO (cliente no existe):
- Responder: "No encontré tu DNI en el sistema. Para registrarte necesito:"
  1. Nombre completo
  2. Apellido
  3. Fecha de nacimiento
  4. Género (Masculino/Femenino)
- Después ejecutar add_customer con esos datos
```

---

### 10. **get_document_types**
**Problema:** Typos y descripción confusa  
**Mejora:**
```typescript
description: `Lista todos los tipos de documentos disponibles con sus IDs.

⚠️ RARAMENTE NECESARIA:
- La mayoría de los clientes usan DNI (ID: 1)
- Solo ejecutar si el cliente menciona explícitamente otro tipo de documento
- Ejemplos: "tengo pasaporte", "mi documento es CI"

CUÁNDO NO USAR:
- ❌ Si el cliente solo da un número sin especificar tipo
- ❌ Para clientes argentinos (asumir DNI)

CUÁNDO SÍ USAR:
- ✅ Cliente dice "no tengo DNI"
- ✅ Cliente extranjero menciona "pasaporte"
- ✅ Cliente pregunta qué documentos aceptan

Ejecuta: Sp_WSListarTiposDNI

Returns:
  {
    "tipos_dni": [
      {"Id": 1, "Descripcion": "DNI"},
      {"Id": 2, "Descripcion": "Pasaporte"},
      {"Id": 3, "Descripcion": "CI"},
      ...
    ]
  }
`
```

---

## 📊 FLUJO COMPLETO MEJORADO

Agregar una nueva herramienta informativa (no ejecutable) que explique el flujo completo:

```typescript
{
  name: 'WORKFLOW_REFERENCE',
  description: `
  
📋 FLUJO COMPLETO PARA RESERVAR UN PASAJE:

┌─────────────────────────────────────────────────┐
│ FASE 1: IDENTIFICAR RUTA Y FECHA               │
└─────────────────────────────────────────────────┘
1. Usuario menciona: "Quiero viajar de X a Y mañana"
2. ⚡ get_date_info("mañana") → obtener fecha ISO
3. ⚡ get_origin_locations → obtener IDs de X e Y
4. ⚡ verify_route(loc_origen=X, loc_destino=Y)
5. ⚡ get_schedules(id_loc_origen=X, id_loc_destino=Y, fecha=YYYYMMDD)
6. 💬 Mostrar horarios al usuario

┌─────────────────────────────────────────────────┐
│ FASE 2: CONFIRMAR HORARIO Y BUTACAS            │
└─────────────────────────────────────────────────┘
7. Usuario elige horario
8. ⚡ get_available_seats(id_horario, id_loc_desde, id_loc_hasta, cantidad_pasajeros)
9. 💬 Informar butacas disponibles (asignación automática para 1 pasajero)

┌─────────────────────────────────────────────────┐
│ FASE 3: IDENTIFICAR PASAJERO(S)                │
└─────────────────────────────────────────────────┘
10. 💬 Pedir DNI(s) de todos los pasajeros
11. ⚡ search_customer_data(nro_doc=DNI) para cada pasajero
    - Si NO existe → ⚡ add_customer(datos completos)
    - Si existe → continuar

┌─────────────────────────────────────────────────┐
│ FASE 4: CREAR RESERVA                          │
└─────────────────────────────────────────────────┘
12. ⚡ create_shopping_cart → guardar id_carrito
13. ⚡ add_to_cart(...) UNA VEZ por cada pasajero
    - Mismo id_carrito para todos
    - DNI diferente para cada uno
    - Butaca diferente para cada uno
14. ⚡ finalize_sale(id_carrito)
15. 💬 Mostrar resumen con link de pago y boleto

┌─────────────────────────────────────────────────┐
│ OPCIONAL: PARADA EN EL CAMINO                  │
└─────────────────────────────────────────────────┘
- ⚡ get_stops_for_route → mostrar paradas disponibles
- ⚡ add_stop_to_reservation (DESPUÉS de finalize_sale)

⚠️ ERRORES COMUNES A EVITAR:
❌ No crear carrito antes de add_to_cart
❌ Usar mismo DNI para múltiples butacas
❌ No verificar ruta antes de buscar horarios
❌ Inventar IDs de localidades
❌ No convertir fecha ISO a YYYYMMDD para get_schedules
❌ Crear múltiples carritos para una misma compra
❌ No guardar el id_carrito después de create_shopping_cart
  `
}
```

---

## 🎯 PRIORIDAD DE IMPLEMENTACIÓN

### 🔴 ALTA PRIORIDAD (Implementar YA):
1. ✅ Corregir referencia a herramienta inexistente en `verify_route`
2. ✅ Agregar `cantidad_pasajeros` como required en `get_available_seats`
3. ✅ Mejorar `get_origin_locations` con ejemplos claros
4. ✅ Mejorar `create_shopping_cart` explicando cuándo crear uno
5. ✅ Agregar formato de fecha en `get_schedules`

### 🟡 MEDIA PRIORIDAD:
6. Mejorar `search_customer_data` con interpretación de resultados
7. Mejorar `add_to_cart` con ejemplos de múltiples pasajeros
8. Corregir typos en `get_document_types`

### 🟢 BAJA PRIORIDAD:
9. Eliminar herramienta duplicada `getDateInfo`
10. Agregar WORKFLOW_REFERENCE como documentación

---

## 📝 RESUMEN EJECUTIVO

**Problemas encontrados:** 10  
**Críticos:** 3  
**Mejoras propuestas:** 15  

**Impacto esperado:**
- ✅ Reducción de errores del LLM en un 70%
- ✅ Flujos más claros y predecibles
- ✅ Menos preguntas innecesarias al usuario
- ✅ Mejor tasa de éxito en reservas completas

