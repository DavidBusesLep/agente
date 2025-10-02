// Import dinámico para evitar problemas de carga/orden
async function execSP(spName: string, params?: Record<string, unknown>) {
  const { sqlServer } = await import('../services/sqlServer');
  return sqlServer.executeStoredProcedure(spName, params);
}

export type LocalToolDef = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any>;
};

// Adaptadores para LangGraph / LangChain: definición de herramientas dinámicas
export function getLangChainTools() {
  // Estructura simple: cada tool incluye name, description, schema Zod-like y executor
  return localTools.map(t => ({
    name: t.name,
    description: t.description,
    schema: t.parameters,
    invoke: async (input: any) => t.execute(input)
  }));
}

// Helpers equivalentes a las utilidades de Python
function normalizeText(value: unknown): string {
  try { return String(value).toLowerCase(); } catch { return ''; }
}

function extractSeatType(descripcion: unknown): string {
  const d = normalizeText(descripcion);
  if (d.includes('semicama')) return 'semicama';
  if (d.includes('cama') && !d.includes('semicama')) return 'cama';
  return '';
}

// Cache simple para localidades de origen
let originLocCache: { data: any[]; expiry: number } | null = null;
const ORIGIN_LOC_CACHE_MS = Number(process.env.ORIGIN_LOCATIONS_CACHE_MS || 300000); // 5 minutos por defecto

export async function getAllOriginLocationsFromDb(): Promise<{ Localidades?: any[]; error?: string }> {
  try {
    const now = Date.now();
    if (originLocCache && originLocCache.expiry > now) {
      return { Localidades: originLocCache.data };
    }
    const res = await execSP('Sp_WSOpenAiLocalidadesOrigenV2');
    if (res.success) {
      const locations = res.data || [];
      originLocCache = { data: locations, expiry: now + ORIGIN_LOC_CACHE_MS };
      return { Localidades: locations };
    }
    return { error: res.error || 'Error ejecutando SP' };
  } catch (e: any) {
    return { error: `Error obteniendo localidades de origen: ${String(e?.message || e)}` };
  }
}

// Utilidades para cálculo y formateo de fechas en español
function capitalizeEs(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDateEs(date: Date) {
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const monthName = new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(date);
  const weekDay = new Intl.DateTimeFormat('es-ES', { weekday: 'long' }).format(date);
  return {
    iso: `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${day}`,
    display: `${capitalizeEs(weekDay)} ${day} de ${capitalizeEs(monthName)} de ${year}`,
    year,
    month: date.getMonth() + 1,
    day: Number(day),
    weekday: capitalizeEs(weekDay)
  };
}

function parseDayOfWeekEs(text: string): number | null {
  const map: Record<string, number> = {
    'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6, 'domingo': 0
  };
  const keys = Object.keys(map);
  for (const k of keys) {
    if (text.includes(k)) return map[k];
  }
  return null;
}

function getNextWeekday(from: Date, targetWeekday: number): Date {
  const d = new Date(from);
  const current = d.getDay();
  let delta = (targetWeekday - current + 7) % 7;
  if (delta === 0) delta = 7; // "próximo" implica futuro
  d.setDate(d.getDate() + delta);
  return d;
}

function safeParseDate(input: string, referenceYear: number): Date | null {
  const t = input.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(t)) {
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  const dmy = /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/;
  const m = t.match(dmy);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    let yy = m[3] ? Number(m[3]) : referenceYear;
    if (yy < 100) yy += 2000;
    const d = new Date(yy, mm - 1, dd);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function diffInDays(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function diffInMonths(a: Date, b: Date): number {
  const y = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  const total = y * 12 + m;
  return Math.abs(total);
}

async function executeGetDateInfo(args: { instruction: string; reference_date?: string }) {
  const instructionRaw = String(args?.instruction || '').toLowerCase();
  if (!instructionRaw) return { error: "'instruction' es requerido" };

  const now = args?.reference_date ? (safeParseDate(String(args.reference_date), new Date().getFullYear()) || new Date()) : new Date();

  // Intentar usar date-fns si está instalado (opcional)
  let dfns: any = null;
  try { dfns = await import('date-fns'); } catch {}

  // Fecha actual
  if (instructionRaw.includes('fecha actual') || instructionRaw === 'hoy' || instructionRaw.includes('hoy es')) {
    const info = formatDateEs(now);
    return { type: 'today', ...info };
  }

  // Próximo día de la semana
  if (instructionRaw.includes('próximo') || instructionRaw.includes('proximo') || instructionRaw.includes('siguiente')) {
    const dow = parseDayOfWeekEs(instructionRaw);
    if (dow !== null) {
      const next = dfns?.nextDay ? dfns.nextDay(now, dow) : getNextWeekday(now, dow);
      const info = formatDateEs(next);
      return { type: 'next_weekday', target_weekday: dow, ...info };
    }
    // Próximo mes / año
    if (instructionRaw.includes('mes')) {
      const d = new Date(now);
      if (dfns?.addMonths) {
        const next = dfns.addMonths(d, 1);
        const info = formatDateEs(next);
        return { type: 'next_month', ...info };
      } else {
        d.setMonth(d.getMonth() + 1);
        const info = formatDateEs(d);
        return { type: 'next_month', ...info };
      }
    }
    if (instructionRaw.includes('año') || instructionRaw.includes('anio')) {
      const d = new Date(now);
      if (dfns?.addYears) {
        const next = dfns.addYears(d, 1);
        const info = formatDateEs(next);
        return { type: 'next_year', ...info };
      } else {
        d.setFullYear(d.getFullYear() + 1);
        const info = formatDateEs(d);
        return { type: 'next_year', ...info };
      }
    }
  }

  // Año de una fecha concreta y/o próximo DD/MM
  const dateLike = instructionRaw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  if (dateLike) {
    const target = safeParseDate(dateLike[1], now.getFullYear());
    if (target) {
      let d = target;
      if (instructionRaw.includes('próximo') || instructionRaw.includes('proximo') || instructionRaw.includes('siguiente')) {
        if (dfns?.isBefore ? dfns.isBefore(target, now) : target.getTime() <= now.getTime()) {
          if (dfns?.addYears) d = dfns.addYears(target, 1); else d = new Date(target.getFullYear() + 1, target.getMonth(), target.getDate());
        }
      }
      const info = formatDateEs(d);
      return { type: 'date_of', input: dateLike[1], ...info };
    }
  }

  // Diferencias en días/meses entre dos fechas
  if (instructionRaw.includes('diferenc') || instructionRaw.includes('cuántos días') || instructionRaw.includes('cuantos dias')) {
    const two = instructionRaw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?).*?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
    if (two) {
      const a = safeParseDate(two[1], now.getFullYear());
      const b = safeParseDate(two[2], now.getFullYear());
      if (a && b) {
        const days = dfns?.differenceInCalendarDays ? Math.abs(dfns.differenceInCalendarDays(a, b)) : diffInDays(a, b);
        const months = dfns?.differenceInCalendarMonths ? Math.abs(dfns.differenceInCalendarMonths(a, b)) : diffInMonths(a, b);
        return { type: 'diff', from: formatDateEs(a), to: formatDateEs(b), diff: { days, months } };
      }
    }
  }

  // Fallback genérico
  const info = formatDateEs(now);
  return { type: 'fallback', note: 'No se pudo interpretar la instrucción. Devuelvo la fecha de referencia.', ...info };
}

export const localTools: LocalToolDef[] = [
  {
    name: 'get_date_info',
    description: `Herramienta de fecha confiable. Interpreta instrucciones en español y devuelve resultados exactos.
Usos típicos: "cuándo es el próximo miércoles", "próximo mes/año", "qué año es el próximo 25/12", "diferencia en días entre 01/09 y 25/09", "fecha actual".
Siempre responde con fechas precisas basadas en el reloj del servidor.
Campos de salida comunes: iso, display, year, month, day, weekday. Para difs: diff.days, diff.months.`,
    parameters: { type: 'object', properties: { instruction: { type: 'string' }, reference_date: { type: 'string' } }, required: ['instruction'], additionalProperties: false },
    execute: async (args) => await executeGetDateInfo(args)
  },
  {
    name: 'getDateInfo',
    description: `Alias de get_date_info. Usa este nombre si el modelo prefiere camelCase.`,
    parameters: { type: 'object', properties: { instruction: { type: 'string' }, reference_date: { type: 'string' } }, required: ['instruction'], additionalProperties: false },
    execute: async (args) => await executeGetDateInfo(args)
  },
  {
    name: 'get_origin_locations',
    description: `Lista todas las localidades de origen disponibles.
No requiere parámetros.
Ejecuta: Sp_WSOpenAiLocalidadesOrigenV2
Necesario para conocer los IDs de las localidades para ejecutar próximas herramientas.
Returns:
  Dict con lista de localidades de origen con ID y nombre`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => await getAllOriginLocationsFromDb()
  },
  {
    name: 'search_customer_data',
    description: `Busca datos del cliente en la base de datos.
- IMPORTANTE: No preguntes por el tipo de documento. Asume siempre DNI (ID 1) a menos que el usuario aclare explícitamente otro.
- Usa esta función cuando el cliente te da su número de documento.
- No es necesario preguntar si el cliente ya está registrado; simplemente busca con esta función.
Ejecuta: Sp_WSOpenAiBuscarDatosCliente

Args:
  parametros: JSON string con nro_doc y opcionalmente id_tipo_doc.
            Ejemplo: '{"nro_doc": "12345678"}'
            Ejemplo 2: '{"id_tipo_doc": 2, "nro_doc": "AB12345"}'

Returns:
  Dict con datos del cliente si existe, array vacío si no existe`,
    parameters: {
      type: 'object',
      properties: {
        id_tipo_doc: { type: 'integer' },
        nro_doc: { type: 'string' }
      },
      required: ['nro_doc'],
      additionalProperties: true
    },
    execute: async (args) => {
      let params: any = args;
      try {
        if (typeof args === 'string') params = JSON.parse(args);
      } catch {
        return { cliente: [], error: 'El parámetro no es un JSON válido.' };
      }
      if (!params || typeof params !== 'object') return { cliente: [], error: 'Formato de parámetro no reconocido.' };
      const id_tipo_doc = params?.id_tipo_doc ?? 1;
      const nro_doc = params?.nro_doc;
      if (!nro_doc) return { cliente: [], error: 'El nro_doc es requerido.' };
      const res = await execSP('Sp_WSOpenAiBuscarDatosCliente', { PidTipodoc: id_tipo_doc, PNroDoc: nro_doc });
      if (res.success) return { cliente: res.data };
      return { cliente: [], error: res.error };
    }
  },
  {
    name: 'add_customer',
    description: `Agrega un nuevo cliente a la base de datos.
- Ejecutar esta función solo si search_customer_data devolvió un cliente vacío.
- IMPORTANTE: No preguntes por el tipo de documento. Asume siempre DNI (ID 1) a menos que el usuario aclare explícitamente otro.
- El id_pais para Argentina es 1.
Ejecuta: Sp_WSOpenAiAgregarCliente

Args:
  parametros: JSON con id_tipo_doc, dni, nombre, apellido, fecha_nac, genero, id_pais.
  Ejemplo: '{"id_tipo_doc": 1, "dni": "12345678", "nombre": "Juan", "apellido": "Perez", "fecha_nac": "1990-01-01", "genero": 1, "id_pais": 1}'

Returns:
  Dict con resultado de la operación.`,
    parameters: {
      type: 'object',
      properties: {
        id_tipo_doc: { type: 'integer' },
        dni: { type: 'string' },
        nombre: { type: 'string' },
        apellido: { type: 'string' },
        fecha_nac: { type: 'string' },
        genero: { type: 'integer' },
        id_pais: { type: 'integer' }
      },
      additionalProperties: true
    },
    execute: async (args) => {
      try {
        let params: any = args;
        if (typeof args === 'string') {
          try { params = JSON.parse(args); } catch { return { Resultado: false, error: 'El formato de los parámetros no es un JSON válido.' }; }
        }
        if (params && typeof params === 'object' && typeof params.parametros === 'string') {
          try { params = JSON.parse(params.parametros); } catch { return { Resultado: false, error: "El JSON anidado en 'parametros' no es válido." }; }
        }

        const id_tipo_doc = params?.id_tipo_doc ?? 1;
        const dni = params?.dni;
        const nombre = params?.nombre;
        const apellido = params?.apellido;
        const fecha_nac = params?.fecha_nac;
        const genero = params?.genero;
        const id_pais = params?.id_pais ?? 1;

        const sp_params = {
          PId_tipoDoc: id_tipo_doc,
          PDNI: dni,
          PNombre: nombre,
          PApellido: apellido,
          PFechaNac: fecha_nac,
          Pidgenero: genero,
          PIdPais: id_pais
        } as Record<string, unknown>;

        const res = await execSP('Sp_WSOpenAiAgregarCliente', sp_params);
        if (res.success) return { Resultado: true, mensaje: 'Cliente agregado exitosamente' };
        return { Resultado: false, error: res.error };
      } catch (e: any) {
        return { Resultado: false, error: `Error agregando cliente: ${String(e?.message || e)}` };
      }
    }
  },
  {
    name: 'get_document_types',
    description: `Herramienta no es necesaria ejecutar si el cliente no especifica tipo de dni o se duda que es extranjero, simpre intentar asumir que es dni (1)
    Lista todos los tipos de documentos disponibles con sus IDs.
    No requiere parámetros.
    Ejecuta: Sp_WSListarTiposDNI
    
    Returns:
        Dict con lista de tipos de documentos (DNI, LC, CI, etc.)
        `,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const res = await execSP('Sp_WSListarTiposDNI');
      return res.success ? { tipos_dni: res.data } : { error: res.error };
    }
  },
  {
    name: 'get_countries',
    description: `Lista todos los países disponibles con sus IDs.
    No requiere parámetros.
    Ejecuta: Sp_WSListarPaises
    
    Returns:
        Dict con lista de países disponibles`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const res = await execSP('Sp_WSListarPaises');
      return res.success ? { listado_paises: res.data } : { error: res.error };
    }
  },
  {
    name: 'verify_route',
    description: `Verifica si existe una ruta de autobús entre dos localidades usando sus IDs.
    
REGLA CRÍTICA: Antes de usar esta herramienta, DEBES obtener los IDs de las localidades de origen y destino utilizando la herramienta \`select_location_from_list\`.
NO asumas ni inventes IDs. Si la herramienta de selección devuelve un error, significa que no se encontró la localidad y debes informar al usuario.

Ejecuta: Sp_WSOpenAiLocalidadesDestinoV2. Si el resultado es false (no hay datos), debes informar al usuario que no existe una ruta directa y transferir la consulta.
si el resultado es false informar al usuario que no hacemos esa ruta
Args:
    parametros: JSON string con loc_origen, loc_destino.
               Ejemplo: '{"loc_origen": 1, "loc_destino": 10}'
        
Returns:
    Dict indicando si la ruta existe`,
    parameters: { type: 'object', properties: { loc_origen: { type: 'integer' }, loc_destino: { type: 'integer' } }, required: ['loc_origen', 'loc_destino'], additionalProperties: false },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiLocalidadesDestinoV2', { PLocOrigen: args.loc_origen, PLocDestino: args.loc_destino });
      if (!res.success) return { Resultado: false, error: res.error };
      let existe = false;
      if (res.data && res.data.length) {
        const first = res.data[0] as any;
        const msg = String(first?.Resultado || first?.resultado || '').toLowerCase();
        existe = msg ? !(msg.includes('no existe') || msg.includes('no hay')) : true;
      }
      return { Resultado: existe, data: res.data };
    }
  },
  {
    name: 'get_schedules',
    description: `Lista horarios disponibles para una ruta y fecha específica.
    - Antes de ejecutar esta herramienta, verifica si existe la ruta con \`verify_route\`.
    - La fecha debe estar en formato YYYYMMDD.
    - La hora es opcional (formato HH:MM). 
    
    **FILTROS ESPECIALES DE HORARIOS:**
    - Si hora = "12:00" → Devuelve TODOS los horarios desde las 12:00 en adelante (tarde/después del mediodía)
    - Si hora = "00:00" → Devuelve TODOS los horarios desde las 00:00 hasta las 11:59 (mañana)
    - Para cualquier otra hora específica → Busca el horario exacto o los más cercanos
    - Sin hora → Devuelve todos los horarios del día
    - NOTA: Los horarios siempre se devuelven ordenados cronológicamente por hora de salida
    - NO CONFUNDAS LOS HORARIOS DE SALIDA CON LOS HORARIOS DE LLEGADA !!!
   IMPORTANTE: Siempre que muestres los horarios al usuario, debes usar el siguiente formato de tabla: no agregues nada al texto ni ** de mas para resaltar solo usa un * ni otra informacion que no esta aca detallada 
    Origen a Destino DD-MM-YYYY
    *Salida* - *Llegada*
    *Programada* - *Estimada*
            06:15                07:30
            08:30                09:45
            10:30                11:45
    Tarifa Ida: $ [MONTO MINIMO] - $ [MONTO MAXIMO]
    Promoción Ida y Vuelta: $ [MONTO_IDA_VUELTA]
    NO incluyas detalles de servicio (Semicama, Directo, etc) en la tabla. 

    Ejecuta: Sp_WSOpenAiListarHorariosV2
    
    Args:
        parametros: JSON string con id_loc_origen, id_loc_destino, fecha y opcionalmente hora. 
                   Ejemplo: '{"id_loc_origen": 1, "id_loc_destino": 10, "fecha": "20250626", "hora": "18:00"}'
        
    Returns:
        Dict con lista de horarios disponibles y un mensaje si se buscaron alternativas.`,
    parameters: { type: 'object', properties: { id_loc_origen: { type: 'integer' }, id_loc_destino: { type: 'integer' }, fecha: { type: 'string' }, horario: { type: 'string' } }, required: ['id_loc_origen', 'id_loc_destino', 'fecha'], additionalProperties: false },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiListarHorariosV2', { PIDLocOrigen: args.id_loc_origen, PIDLocDestino: args.id_loc_destino, PFecha: args.fecha });
      return res.success ? { Horarios: res.data } : { error: res.error };
    }
  },
  {
    name: 'get_available_seats',
    description: `Consulta y sugiere butacas disponibles para un horario específico según la cantidad de pasajeros y, opcionalmente, por tipo de butaca.

    **REGLAS CRÍTICAS DE USO:**
    
    **PARA UN SOLO PASAJERO:**
    - Esta herramienta sugiere automáticamente butacas del CENTRO del coche (más cómodas)
    - Si el cliente NO especificó una butaca particular, usa la PRIMERA butaca sugerida automáticamente
    - NO preguntes al cliente qué butaca prefiere, simplemente asigna la primera de la lista de sugerencias
    - Solo pregunta por butaca específica si el cliente lo solicita explícitamente
    
    **PARA MÚLTIPLES PASAJEROS:**
    - Si esta herramienta devuelve butacas sugeridas, tu **PRÓXIMO PASO OBLIGATORIO** es pedir el DNI de CADA UNO de los pasajeros
    - Asigna automáticamente las butacas sugeridas a cada pasajero sin preguntar

    - Esta herramienta ya realiza la búsqueda inteligente de asientos juntos o en el centro.
    - Debes usar los IDs de 'id_loc_desde' y 'id_loc_hasta' de la ruta que consultó el usuario.

    Ejecuta: Sp_WSOpenAiEstadoPlantaHorarioV2
   
    Args:
        parametros: JSON string con id_horario, id_loc_desde, id_loc_hasta, cantidad_pasajeros y opcionalmente tipo_butaca.
                   - tipo_butaca: (Opcional) Filtra por "Cama", "Semicama", etc. Si se omite o es "cualquiera", no filtra.
                   Ejemplo: '{"id_horario": "123", "id_loc_desde": 1, "id_loc_hasta": 10, "cantidad_pasajeros": 1, "tipo_butaca": "Cama"}'
        
    Returns:
        Dict con una lista de 'butacas_sugeridas' y un 'detalle' de la sugerencia.`,
    parameters: { type: 'object', properties: { id_horario: { type: 'string' }, id_loc_desde: { type: 'integer' }, id_loc_hasta: { type: 'integer' }, cantidad_pasajeros: { type: 'integer' }, tipo_butaca: { type: 'string' } }, required: ['id_horario', 'id_loc_desde', 'id_loc_hasta'], additionalProperties: true },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiEstadoPlantaHorarioV2', { id_horario: args.id_horario, PId_LocalidadDesde: args.id_loc_desde, PId_LocalidadHasta: args.id_loc_hasta });
      if (!res.success) return { error: res.error };
      // Filtro opcional por tipo de butaca (estricto: evita que 'cama' matchee 'semicama')
      const tipo = normalizeText((args as any).tipo_butaca || '');
      let data = res.data || [];
      if (tipo && tipo !== 'cualquiera') {
        data = data.filter((b: any) => extractSeatType(b?.descripcion) === tipo);
      }
      return { butacas: data };
    }
  },
  {
    name: 'verify_specific_seats',
    description: `Verifica si una lista específica de números de butaca está disponible para un horario y tramo determinado.
    Úsala SIEMPRE que un cliente solicite un número de butaca específico, tanto en la venta inicial como en una modificación.

    Args:
        parametros: JSON string con:
            - id_horario (str): El ID del horario.
            - id_loc_desde (int): ID de la localidad de origen del tramo.
            - id_loc_hasta (int): ID de la localidad de destino del tramo.
            - numeros_butaca (List[int]): Una lista de los números de butaca a verificar.
            Ejemplo: '{"id_horario": "1-6-9902", "id_loc_desde": 6, "id_loc_hasta": 1, "numeros_butaca": [20, 21]}'

    Returns:
        Un diccionario con dos listas:
        - 'butacas_disponibles': Las butacas solicitadas que sí están disponibles.
        - 'butacas_no_disponibles': Las butacas solicitadas que NO están disponibles.
`,
    parameters: { type: 'object', properties: { id_horario: { type: 'string' }, id_loc_desde: { type: 'integer' }, id_loc_hasta: { type: 'integer' }, numeros_butaca: { type: 'array', items: { type: 'integer' } } }, required: ['id_horario', 'id_loc_desde', 'id_loc_hasta', 'numeros_butaca'], additionalProperties: false },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiEstadoPlantaHorarioV2', { id_horario: args.id_horario, PId_LocalidadDesde: args.id_loc_desde, PId_LocalidadHasta: args.id_loc_hasta });
      if (!res.success) return { error: res.error };
      const disponibles = new Set((res.data || []).map((r: any) => r.NumeroDeButaca));
      const ok: number[] = []; const nok: number[] = [];
      for (const n of args.numeros_butaca as number[]) (disponibles.has(n) ? ok : nok).push(n);
      return { butacas_disponibles: ok, butacas_no_disponibles: nok, detalle: `Disponibles ${ok.length}, no disponibles ${nok.length}` };
    }
  },
  {
    name: 'find_seats_by_description',
    description: `Busca butacas disponibles que coincidan con una descripción textual.
    Úsala cuando el cliente pide una butaca por sus características en lugar de por su número.
    
    MAPEO AUTOMÁTICO DE TÉRMINOS:
    - "ventanilla" / "ventana" → busca "lado ventana"
    - "individual" → busca literalmente "individual" en la descripción (ej: "Cama individual")
    - "pasillo" → busca "lado pasillo"
    - "semicama" → busca butacas tipo "Semicama"
    - "cama" → busca butacas tipo "Cama"

    Args:
        parametros: JSON string con:
            - id_horario (str): El ID del horario.
            - id_loc_desde (int): ID de la localidad de origen del tramo.
            - id_loc_hasta (int): ID de la localidad de destino del tramo.
            - criterio (str): El texto a buscar ("ventanilla", "individual", "pasillo", etc.)
            Ejemplo: '{"id_horario": "1-6-9902", "id_loc_desde": 6, "id_loc_hasta": 1, "criterio": "individual"}'

    Returns:
        Un diccionario con una lista de 'butacas_encontradas', cada una con su número y descripción.
`,
    parameters: { type: 'object', properties: { id_horario: { type: 'string' }, id_loc_desde: { type: 'integer' }, id_loc_hasta: { type: 'integer' }, criterio: { type: 'string' } }, required: ['id_horario', 'id_loc_desde', 'id_loc_hasta', 'criterio'], additionalProperties: false },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiEstadoPlantaHorarioV2', { id_horario: args.id_horario, PId_LocalidadDesde: args.id_loc_desde, PId_LocalidadHasta: args.id_loc_hasta });
      if (!res.success) return { error: res.error };
      const term = String(args.criterio || '').toLowerCase();
      const list = (res.data || []).filter((b: any) => String(b.descripcion || '').toLowerCase().includes(term)).map((b: any) => ({ NumeroDeButaca: b.NumeroDeButaca, descripcion: b.descripcion }));
      return { butacas_encontradas: list, detalle: `Coincidencias: ${list.length}` };
    }
  },
  {
    name: 'analyze_seats_together',
    description: `Analiza una lista de butacas disponibles para determinar si la cantidad de pasajeros solicitada puede sentarse junta y sugiere qué butacas usar.
Prioriza la asignación de pasajeros en pares de asientos juntos (lado ventana y lado pasillo en la misma fila y columna).

Args:
- parametros: Un diccionario o un string JSON con las claves 'butacas_disponibles' y 'cantidad_pasajeros'.
             Ejemplo: '{"butacas_disponibles": [{"NumeroDeButaca": 1, "descripcion": "Piso(1)-Fila(1)-Columna(1)-Ventana", ...}], "cantidad_pasajeros": 2}'

Returns:
- 'resultado' (bool): True si es posible sentar a todos los pasajeros.
- 'detalle' (str): Explicación de la asignación o del porqué no fue posible.
- 'butacas_sugeridas' (list): Lista de números de butaca sugeridos para la reserva. Estará vacía si no es posible.`,
    parameters: {
      type: 'object',
      properties: {
        butacas_disponibles: { type: 'array', items: { type: 'object' } },
        cantidad_pasajeros: { type: 'integer' }
      },
      required: ['butacas_disponibles', 'cantidad_pasajeros'],
      additionalProperties: false
    },
    execute: async (args) => {
      // Parseo robusto (por si llegara string)
      let params: any = args;
      try { if (typeof args === 'string') params = JSON.parse(args); } catch {}
      const butacas: any[] = Array.isArray(params?.butacas_disponibles) ? params.butacas_disponibles : [];
      let cantidad = Number(params?.cantidad_pasajeros ?? 0);
      if (!butacas.length || !Number.isFinite(cantidad) || cantidad <= 0) {
        return { resultado: false, detalle: "Error: Faltan 'butacas_disponibles' o 'cantidad_pasajeros' válidos.", butacas_sugeridas: [] };
      }

      // Agrupar por (piso, columna, fila) para identificar pares ventana/pasillo en misma fila/columna
      const grupos: Record<string, any[]> = {};
      for (const b of butacas) {
        try {
          const parts = String(b?.descripcion || '').split('-');
          const pisoPart = parts.find(p => p.includes('Piso'));
          const colPart = parts.find(p => p.includes('Columna'));
          const filaPart = parts.find(p => p.includes('Fila'));
          if (!pisoPart || !colPart || !filaPart) continue;
          const piso = Number(pisoPart.split('(')[1].split(')')[0]);
          const col = Number(colPart.split('(')[1].split(')')[0]);
          const fila = Number(filaPart.split('(')[1].split(')')[0]);
          const key = `${piso}|${col}|${fila}`;
          if (!grupos[key]) grupos[key] = [];
          grupos[key].push(b);
        } catch {
          continue;
        }
      }

      // Construir pares tomando de a 2 dentro de cada grupo
      const pares: any[][] = [];
      const butacasEnPares = new Set<number>();
      const sortedKeys = Object.keys(grupos).sort();
      for (const k of sortedKeys) {
        const g = grupos[k];
        if (g.length >= 2) {
          for (let i = 0; i < g.length - 1; i += 2) {
            const p = [g[i], g[i + 1]];
            pares.push(p);
            try { butacasEnPares.add(Number(p[0]?.NumeroDeButaca)); } catch {}
            try { butacasEnPares.add(Number(p[1]?.NumeroDeButaca)); } catch {}
          }
        }
      }

      // Individuales excluyendo las usadas en pares, ordenadas por NumeroDeButaca
      const individuales = butacas
        .filter(b => !butacasEnPares.has(Number(b?.NumeroDeButaca)))
        .sort((a, b) => Number(a?.NumeroDeButaca) - Number(b?.NumeroDeButaca));

      let pasajerosRestantes = Math.trunc(cantidad);
      const sugeridas: number[] = [];
      const detalle: string[] = [];

      // 1) Asignar en pares primero
      const paresNecesarios = Math.floor(pasajerosRestantes / 2);
      const aUsar = Math.min(paresNecesarios, pares.length);
      for (let i = 0; i < aUsar; i++) {
        const par = pares[i];
        const nums = par.map(p => Number(p?.NumeroDeButaca)).filter(n => Number.isFinite(n));
        sugeridas.push(...nums);
      }
      if (aUsar > 0) {
        pasajerosRestantes -= aUsar * 2;
        detalle.push(`${aUsar * 2} pasajero(s) en ${aUsar} par(es)`);
      }

      // 2) Asignar individuales restantes
      const indNecesarios = pasajerosRestantes;
      const indAsignados = Math.min(indNecesarios, individuales.length);
      for (let i = 0; i < indAsignados; i++) {
        const nb = Number(individuales[i]?.NumeroDeButaca);
        if (Number.isFinite(nb)) sugeridas.push(nb);
      }
      if (indAsignados > 0) {
        pasajerosRestantes -= indAsignados;
        detalle.push(`${indAsignados} pasajero(s) en asientos individuales`);
      }

      if (pasajerosRestantes === 0) {
        const detalleFinal = `Sí, es posible ubicar a los ${cantidad} pasajeros. Asignación: ${detalle.join(', ')}.`;
        return { resultado: true, detalle: detalleFinal, butacas_sugeridas: sugeridas.sort((a, b) => a - b) };
      }
      const detalleNo = `No es posible ubicar a los ${cantidad} pasajeros con los asientos disponibles. Solo se pueden ubicar ${cantidad - pasajerosRestantes}.`;
      return { resultado: false, detalle: detalleNo, butacas_sugeridas: [] };
    }
  },
  {
    name: 'create_shopping_cart',
    description: `Crea un nuevo carrito de compras para iniciar el proceso de reserva.
    - este numero es unico por compra y se debe usar siempre que se inicie una nueva compra. en un carrito puede haber multiples reservas.
    Ejecuta: sp_carrito_compras_create
    
    Returns:
        Dict con ID del carrito creado
`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const res = await execSP('sp_carrito_compras_create');
      return res.success ? { carrito: res.data } : { error: res.error };
    }
  },
  {
    name: 'add_to_cart',
    description: `Agrega UNA reserva INDIVIDUAL al carrito. Debes llamar esta herramienta una vez por cada pasajero.
    
    **Recordatorio**: NO uses el mismo DNI para varias butacas. Cada llamada a esta función debe ser para un pasajero y butaca únicos.

    - **IMPORTANTE**: No preguntes por el tipo de documento. Asume siempre DNI (ID 1) a menos que el usuario aclare explícitamente otro.
    - Prerrequisitos: get_schedules, get_available_seats, search_customer_data.
    Ejecuta: sp_carrito_compras_insertV2
    
    Args:
        parametros: JSON string con:
            - id_carrito, id_horario, id_localidad_origen, id_localidad_destino, id_tipo_doc, dni, numero_butaca
            - tipo_venta: String corto indicando el tipo ("link", "beg", "bec", etc.)
            - con_vuelta_abierta: "si" o "no" - para boletos con fecha de regreso abierta
        
        Ejemplo: '{"id_carrito": 123, "id_horario": "1-2-3", ..., "tipo_venta": "link", "con_vuelta_abierta": "no"}'
        
    Returns:
        Dict con resultado de la operación
`,
    parameters: { type: 'object', properties: { id_carrito: { type: 'integer' }, id_horario: { type: 'string' }, id_localidad_origen: { type: 'integer' }, id_localidad_destino: { type: 'integer' }, id_tipo_doc: { type: 'integer' }, dni: { type: 'string' }, numero_butaca: { type: 'integer' }, tipo_venta: { type: 'string' }, con_vuelta_abierta: { type: 'string' } }, required: ['id_carrito', 'id_horario', 'id_localidad_origen', 'id_localidad_destino', 'dni', 'numero_butaca'], additionalProperties: true },
    execute: async (args) => {
      const res = await execSP('sp_carrito_compras_insertV2', { id_carrito: args.id_carrito, id_horario: args.id_horario, id_localidad_origen: args.id_localidad_origen, id_localidad_destino: args.id_localidad_destino, idTipoDoc: args.id_tipo_doc ?? 1, dni: String(args.dni), numeroButaca: args.numero_butaca, tipo_venta: args.tipo_venta ?? 'link', con_vuelta_abierta: args.con_vuelta_abierta ?? 'no' });
      return res.success ? (res.data?.[0] ?? { success: true }) : { success: false, error: res.error };
    }
  },
  {
    name: 'get_stops_for_route',
    description: `Obtiene una lista de las paradas oficiales en el camino entre una localidad de origen y una de destino.
    Úsala cuando el usuario indique que quiere subir al autobús en un punto intermedio que no es la terminal (ej: "en la rotonda", "en tal esquina", "en la YPF").
    
    Args:
        parametros: JSON string con id_loc_origen, id_loc_destino.
                   Ejemplo: '{"id_loc_origen": 1, "id_loc_destino": 10}'
    
    Returns:
        Dict con una lista de paradas disponibles para esa ruta.
`,
    parameters: { type: 'object', properties: { id_loc_origen: { type: 'integer' }, id_loc_destino: { type: 'integer' } }, required: ['id_loc_origen', 'id_loc_destino'], additionalProperties: false },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiObtenerParadasPorOrigenDestino', { PLocOrigen: args.id_loc_origen, PLocDestino: args.id_loc_destino });
      return res.success ? { paradas: res.data } : { error: res.error };
    }
  },
  {
    name: 'add_stop_to_reservation',
    description: `Agenda una parada específica en el camino para una reserva de pasajero.
    **CRÍTICO**: Úsala DESPUÉS de haber finalizado la venta con finalize_sale.
    NO la uses antes de confirmar la venta, ya que la reserva no existirá todavía.
    
    Args:
        parametros: JSON string con id_loc_origen, id_loc_destino, dni del pasajero y nombre_parada.
                   Ejemplo: '{"id_loc_origen": 1, "id_loc_destino": 10, "dni": "12345678", "nombre_parada": "Rotonda las Flores"}'
                   
    Returns:
        Dict con el resultado de la operación.`,
    parameters: { type: 'object', properties: { id_loc_origen: { type: 'integer' }, id_loc_destino: { type: 'integer' }, dni: { type: 'string' }, nombre_parada: { type: 'string' } }, required: ['id_loc_origen', 'id_loc_destino', 'dni', 'nombre_parada'], additionalProperties: false },
    execute: async (args) => {
      const { sqlServer } = await import('../services/sqlServer');
      const res = await sqlServer.executeStoredProcedure('Sp_WSOpenAiAgregar_parada_en_camino', { PLocOrigen: args.id_loc_origen, PLocDestino: args.id_loc_destino, PDni: String(args.dni), PNombreParada: args.nombre_parada });
      return res.success ? (res.data?.[0] ?? { success: true }) : { error: res.error };
    }
  },
  {
    name: 'modify_seat_reservation',
    description: `Modifica **ÚNICAMENTE EL NÚMERO DE ASIENTO** de una reserva reciente ya finalizada.
    
    **ADVERTENCIA IMPORTANTE:**
    - **NO USAR ESTA HERRAMIENTA para cambiar de horario, fecha, origen o destino.**
    - Esta herramienta **NO PUEDE** modificar el horario del viaje.
    - Si el cliente quiere cambiar el horario, debes iniciar una **NUEVA RESERVA DESDE CERO**:
      1. Busca los nuevos horarios con get_schedules.
      2. Pide al cliente que confirme el nuevo horario.
      3. Reserva el nuevo pasaje (asientos, carrito, finalizar venta).
      4. Informa al cliente que la reserva anterior queda sin efecto y que debe usar los nuevos links de pago/boleto.

    **CUÁNDO USAR (SOLO PARA CAMBIO DE BUTACA):**
    - Cuando en la misma conversación, después de que Teo haya dado el resumen con las butacas asignadas,
      el cliente pida una modificación de esas mismas butacas para el **MISMO VIAJE Y HORARIO**.
    - Solo funciona para reservas recientes que ya fueron finalizadas con finalize_sale.
    
    Ejecuta: Sp_WSOpenAimodificar_asiento_reserva_reciente
    
    Args:
        parametros: JSON string con:
        - 'link_boleto': El link de descarga que devolvió finalize_sale.
        - 'datos_modificados': Array con datos de pasajeros y **NUEVAS BUTACAS**.
        
        Ejemplo: '{
            "link_boleto": "[VALOR DE Link_descarga_boleto DE LA OBSERVACIÓN DE FINALIZE_SALE]",
            "datos_modificados": [
                {"idTipoDoc": 1, "dni": "xx.xxx.xxx", "numeroButaca": x},
                {"idTipoDoc": 1, "dni": "xx.xxx.xxx", "numeroButaca": x}
            ]
        }'
        
    Returns:
        Dict con resultado de la modificación de la butaca.`
        ,
    parameters: { type: 'object', properties: { link_boleto: { type: 'string' }, datos_modificados: { type: 'array', items: { type: 'object' } } }, required: ['link_boleto', 'datos_modificados'], additionalProperties: false },
    execute: async (args) => {
      const match = String(args.link_boleto).match(/[?&]id=(\d+)/);
      if (!match) return { success: false, error: 'No se pudo extraer id del boleto del link' };
      const boletoId = match[1];
      const res = await execSP('Sp_WSOpenAimodificar_asiento_reserva_reciente', { PLinkBoleto: boletoId, PDatosModificados: JSON.stringify(args.datos_modificados) });
      return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
    }
  },
  {
    name: 'finalize_sale',
    description: `Finaliza la venta y genera enlaces de pago y descarga de boletos.
    - ejecucion final luego de haber cargado todas las reservas en el carrito.
    📝 **FORMATO DE MENSAJE FINAL DESPUÉS DE finalize_sale:**

    **SI HAY LINK DE MERCADOPAGO (pago pendiente) - PARA CUALQUIER TIPO DE VIAJE:**
    - **SIEMPRE** mostrar el link de pago cuando existe
    - **NO IMPORTA** si es viaje simple o ida y vuelta
    - **SI HAY Link_de_pago** → Mostrar formato con link de pago

    **FORMATO PARA IDA Y VUELTA CON LINK DE PAGO:**
    
    ✅ Tu viaje quedó así:

    📋 **IDA**
    🚍 [Origen] → [Destino]
    📅 [Fecha en formato YYYY-MM-DD] a las [Hora]
    💺 Butaca: [Número]

    📋 **VUELTA**
    🚍 [Origen] → [Destino]
    📅 [Fecha en formato YYYY-MM-DD] a las [Hora]
    💺 Butaca: [Número]

    Link de pago: [URL de MercadoPago]
    ⏰ Disponible hasta el [Fecha y hora de vencimiento]
    
    👉 Tené en cuenta: si no abonás antes de ese horario, *el link se vence y la reserva se cancela automáticamente.
    Una vez pagado, recibís el pasaje por mail o podés descargarlo desde aca
    
    🎟️ Boleto: [URL del boleto]
    

    **FORMATO PARA VIAJE SIMPLE CON LINK DE PAGO:**
    
    ✅ Tu viaje quedó así:

    📋 **Resumen del viaje**
    🚍 [Origen] → [Destino]
    📅 [Fecha DD/MM/YYYY] a las [Hora]
    👤 Pasajero(s): [DNI(s)]
    💺 Butaca(s): [Número(s)]

    Link de pago: [URL de MercadoPago]
    ⏰ Disponible hasta el [Fecha y hora de vencimiento]

    👉 Tené en cuenta: si no abonás antes de ese horario, *el link se vence y la reserva se cancela automáticamente. 
    Una vez pagado, recibís el pasaje por mail o podés descargarlo desde aca
    
    🎟️ Boleto: [URL del boleto]
    

    
    **IMPORTANTE:** 
    - No agregues texto al link ni lo conviertas en texto clickeable. WhatsApp necesita que el link esté en formato completo y sin modifica ni al link ni al boleto.
    - **SIEMPRE** verificar si existe Link_de_pago en el resultado
    - **SI EXISTE** → Mostrar el link de pago, fecha de vencimiento y link del boleto
    - **SI NO EXISTE** → Solo mostrar el link del boleto con el mensaje "Tu boleto está listo para descargar"
    - Usa la información real del contexto (origen, destino, fecha, hora) para completar estos campos
    - NO dejes placeholders como [Origen] o [Destino]

    Ejecuta: Sp_WSOpenAiConcretarVentaV2
    
    Args:
        id_carrito: ID del carrito con todas las reservas. Puede ser un string simple o un JSON como '{"id_carrito": "..."}'.
        
    Returns:
        Dict con links de pago y descarga de boletos`,
    parameters: { type: 'object', properties: { id_carrito: { type: 'string' } }, required: ['id_carrito'], additionalProperties: false },
    execute: async (args) => {
      const res = await execSP('Sp_WSOpenAiConcretarVentaV2', { id_carrito: args.id_carrito });
      return res.success ? (res.data?.[0] ?? { success: true }) : { success: false, error: res.error };
    }
  }
];

export function getOpenAiToolDefs() {
  return localTools.slice(0, 64).map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function executeLocalTool(name: string, args: any) {
  const tool = localTools.find(t => t.name === name);
  if (!tool) return { error: `Tool not found: ${name}` };
  try { return await tool.execute(args); } catch (e: any) { return { error: String(e?.message || e) }; }
}


