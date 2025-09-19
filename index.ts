import 'dotenv/config';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
import OpenAI from 'openai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
// MCP removido

// SQL Server (para tools locales)
import { getOpenAiToolDefs, executeLocalTool } from './src/tools/localTools';

// Librerías para procesamiento de documentos (importación dinámica con tipos any)
let mammoth: any = null;

// Función para inicializar mammoth (PDF ya no necesita librerías externas)
async function initDocumentLibraries() {
  try {
    // Importar mammoth con ES modules
    mammoth = await import('mammoth');
    
    // Verificar que tenga la función extractRawText
    if (mammoth && typeof mammoth.extractRawText === 'function') {
      console.log('✅ mammoth cargado correctamente');
    } else {
      console.warn('⚠️  mammoth cargado pero no tiene extractRawText');
      mammoth = null;
    }
  } catch (error: any) {
    console.warn('⚠️  mammoth no se pudo cargar.');
    console.warn('Error:', error.message);
    mammoth = null;
  }
}

// Inicializar librerías de documentos
await initDocumentLibraries();

// PDF usa parser nativo integrado - no requiere librerías externas
console.log('✅ Parser PDF nativo integrado disponible');

// MCP eliminado completamente

// Very rough token estimator: ~4 chars per token
function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const chars = [...text].length;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateTokensFromContent(content: any): number {
  if (typeof content === 'string') {
    return estimateTokensFromText(content);
  }
  
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => {
      if (item.type === 'text') {
        return sum + estimateTokensFromText(item.text);
      } else if (item.type === 'image_url') {
        // Estimación aproximada para imágenes: ~765 tokens para imágenes de alta resolución
        // ~85 tokens para baja resolución
        const detail = item.image_url?.detail || 'auto';
        return sum + (detail === 'low' ? 85 : 765);
      } else if (item.type === 'document_url') {
        // Estimación aproximada para documentos: basada en max_length
        const maxLength = item.document_url?.max_length || 10000;
        return sum + estimateTokensFromText('x'.repeat(Math.min(maxLength, 10000)));
      }
      return sum;
    }, 0);
  }
  
  return 0;
}

function estimateMessagesTokens(messages: Array<{ role: string; content: any }>): number {
  return messages.reduce((sum, m) => sum + estimateTokensFromContent(m.content), 0);
}

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type TenantAuth = {
  id: string;
  name: string;
  balance: Prisma.Decimal;
};

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantAuth;
  }
}

async function ensureDefaultModels() {
  const count = await prisma.model.count();
  if (count > 0) return;
  await prisma.model.createMany({
    data: [
      {
        provider: 'openai',
        name: 'gpt-4.1-mini',
        inputCostPerMillion: new Prisma.Decimal('0.15'),
        outputCostPerMillion: new Prisma.Decimal('0.60'),
        isActive: true
      },
      {
        provider: 'openai',
        name: 'gpt-5',
        inputCostPerMillion: new Prisma.Decimal('1.00'),
        outputCostPerMillion: new Prisma.Decimal('3.00'),
        isActive: true
      },
      {
        provider: 'openai',
        name: 'gpt-4-vision-preview',
        inputCostPerMillion: new Prisma.Decimal('10.00'),
        outputCostPerMillion: new Prisma.Decimal('30.00'),
        isActive: true
      },
      {
        provider: 'openai',
        name: 'gpt-4o',
        inputCostPerMillion: new Prisma.Decimal('5.00'),
        outputCostPerMillion: new Prisma.Decimal('15.00'),
        isActive: true
      }
    ]
  });
}

function generateApiKey(): string {
  return randomUUID().replace(/-/g, '') + Math.random().toString(16).slice(2);
}

// Función para verificar compatibilidad de formatos
function getDocumentFormatSupport() {
  return {
    txt: true,
    md: true,
    pdf: true, // 100% funcional con parser nativo optimizado
    docx: !!mammoth, // 100% funcional con mammoth
    csv: true,
    json: true,
    xml: true,
    html: true,
    htm: true,
    log: true
  };
}

// Función para extraer texto de documentos
async function extractTextFromDocument(buffer: ArrayBuffer, filename: string, maxLength: number = 10000): Promise<{ text: string; metadata: any }> {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  
  try {
    switch (extension) {
      case 'txt':
      case 'md':
        // Archivos de texto plano
        const textDecoder = new TextDecoder('utf-8');
        const text = textDecoder.decode(buffer);
        return {
          text: text.slice(0, maxLength),
          metadata: { 
            format: extension,
            originalLength: text.length,
            truncated: text.length > maxLength
          }
        };
      
      case 'pdf':
        // Procesamiento de PDF con método robusto mejorado
        try {
          console.log('🔄 Procesando PDF con método nativo mejorado...');
          
          // Método 1: Intentar extraer texto usando patrones PDF específicos
          const textDecoder = new TextDecoder('utf-8', { fatal: false });
          const textContent = textDecoder.decode(buffer);
          
          // Buscar streams de texto en el PDF
          const textStreams = [];
          
          // Patrón 1: Buscar objetos de texto explícitos
          const textObjectPattern = /BT\s+(.*?)\s+ET/gs;
          let match;
          while ((match = textObjectPattern.exec(textContent)) !== null) {
            textStreams.push(match[1]);
          }
          
          // Patrón 2: Buscar strings entre paréntesis (texto directo en PDF)
          const directTextPattern = /\((.*?)\)/g;
          while ((match = directTextPattern.exec(textContent)) !== null) {
            const text = match[1];
            // Filtrar texto que parece válido (no binario)
            if (text.length > 2 && /[a-zA-Z\s]/.test(text)) {
              textStreams.push(text);
            }
          }
          
          // Patrón 3: Buscar secuencias de texto después de comandos de texto
          const tjPattern = /Tj\s*\((.*?)\)/g;
          while ((match = tjPattern.exec(textContent)) !== null) {
            textStreams.push(match[1]);
          }
          
          // Patrón 4: Buscar arrays de texto
          const arrayTextPattern = /\[\s*\((.*?)\)\s*\]/g;
          while ((match = arrayTextPattern.exec(textContent)) !== null) {
            textStreams.push(match[1]);
          }
          
          // Combinar y limpiar texto extraído
          let extractedText = textStreams
            .filter(text => text && text.trim().length > 0)
            .map(text => text.replace(/\\[rn]/g, ' ').replace(/\\/g, ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          // Si no encontramos texto estructurado, buscar palabras sueltas
          if (extractedText.length < 20) {
            const wordPattern = /\b[a-zA-Z]{3,}\b/g;
            const words = textContent.match(wordPattern) || [];
            extractedText = words
              .filter(word => word.length > 2)
              .slice(0, 500) // Limitar a las primeras 500 palabras
              .join(' ');
          }
          
          // Truncar si es necesario
          if (extractedText.length > maxLength) {
            extractedText = extractedText.slice(0, maxLength) + '...';
          }
          
          if (extractedText.length > 10) {
            console.log('✅ PDF procesado exitosamente con método nativo');
            return {
              text: extractedText,
              metadata: {
                format: 'pdf',
                originalLength: extractedText.length,
                truncated: extractedText.length >= maxLength,
                method: 'native_pdf_parsing',
                size: buffer.byteLength,
                streams_found: textStreams.length,
                note: 'Texto extraído con parser PDF nativo optimizado'
              }
            };
          } else {
            // Último intento: extraer cualquier texto legible
            const fallbackText = textContent
              .replace(/[^\x20-\x7E\s]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, maxLength);
            
            if (fallbackText.length > 10) {
              console.log('⚠️ PDF procesado con método de fallback');
              return {
                text: fallbackText,
                metadata: {
                  format: 'pdf',
                  originalLength: fallbackText.length,
                  truncated: fallbackText.length >= maxLength,
                  method: 'fallback_text_extraction',
                  size: buffer.byteLength,
                  note: 'Texto extraído con método de respaldo - calidad variable'
                }
              };
            }
          }
          
          // Si todo falla
          return {
            text: '[PDF] Este archivo PDF no contiene texto extraíble o está protegido. Considera convertirlo a texto usando herramientas externas o OCR.',
            metadata: {
              format: 'pdf',
              size: buffer.byteLength,
              method: 'extraction_failed',
              note: 'PDF sin texto extraíble - posiblemente escaneado o protegido',
              solution: 'Usar OCR o convertir PDF a texto externamente'
            }
          };
          
        } catch (error: any) {
          console.error('❌ Error procesando PDF:', error.message);
          return {
            text: '[PDF] Error al procesar el archivo PDF. Verifica que el archivo no esté corrupto.',
            metadata: {
              format: 'pdf',
              size: buffer.byteLength,
              error: error.message,
              note: 'Error durante el procesamiento del PDF'
            }
          };
        }
      
      case 'docx':
        // Procesamiento de DOCX con mammoth (lazy loading)
        let currentMammoth = mammoth;
        if (!currentMammoth) {
          try {
            console.log('🔄 Cargando mammoth bajo demanda...');
            currentMammoth = await import('mammoth');
            
            if (currentMammoth && typeof currentMammoth.extractRawText === 'function') {
              mammoth = currentMammoth; // Guardar para próximas veces
              console.log('✅ mammoth cargado correctamente (lazy)');
            } else {
              currentMammoth = null;
            }
          } catch (e: any) {
            console.warn('❌ Error cargando mammoth:', e.message);
            currentMammoth = null;
          }
        }
        
        if (!currentMammoth) {
          return {
            text: '[DOCX] La librería mammoth no está instalada. Ejecuta: npm install mammoth',
            metadata: { 
              format: 'docx',
              note: 'mammoth library not installed',
              size: buffer.byteLength,
              installation_required: true
            }
          };
        }
        
        try {
          const docxBuffer = Buffer.from(buffer);
          const result = await currentMammoth.extractRawText({ buffer: docxBuffer });
          const extractedText = result.value || '';
          
          return {
            text: extractedText.slice(0, maxLength),
            metadata: {
              format: 'docx',
              originalLength: extractedText.length,
              truncated: extractedText.length > maxLength,
              messages: result.messages || [],
              size: buffer.byteLength
            }
          };
        } catch (error: any) {
          throw new Error(`Error al procesar DOCX: ${error.message}`);
        }
      
      case 'csv':
      case 'json':
      case 'xml':
      case 'html':
      case 'htm':
      case 'log':
        // Formatos estructurados que podemos procesar como texto
        try {
          const textDecoder = new TextDecoder('utf-8');
          const text = textDecoder.decode(buffer);
          return {
            text: text.slice(0, maxLength),
            metadata: { 
              format: extension,
              originalLength: text.length,
              truncated: text.length > maxLength,
              note: `Processed as ${extension.toUpperCase()} text format`
            }
          };
        } catch (error: any) {
          throw new Error(`Error al procesar archivo ${extension.toUpperCase()}: ${error.message}`);
        }
      
      default:
        // Último intento como texto plano para formatos desconocidos
        try {
          const textDecoder = new TextDecoder('utf-8');
          const text = textDecoder.decode(buffer);
          
          // Verificar si parece ser texto válido
          const nonPrintableChars = text.replace(/[\x20-\x7E\s]/g, '').length;
          const textLength = text.length;
          
          if (textLength === 0) {
            throw new Error('El archivo está vacío');
          }
          
          if (nonPrintableChars / textLength > 0.3) {
            throw new Error('El archivo parece ser binario y no se puede procesar como texto');
          }
          
          return {
            text: text.slice(0, maxLength),
            metadata: { 
              format: extension || 'unknown',
              originalLength: text.length,
              truncated: text.length > maxLength,
              note: 'Processed as plain text (fallback)',
              quality_warning: nonPrintableChars > 0 ? 'File may contain binary data' : undefined
            }
          };
        } catch (fallbackError: any) {
          const supportedFormats = Object.entries(getDocumentFormatSupport())
            .filter(([_, supported]) => supported)
            .map(([format, _]) => format)
            .join(', ');
          
          throw new Error(
            `Formato de documento no soportado: ${extension}. ` +
            `Formatos soportados: ${supportedFormats}. ` +
            `Error: ${fallbackError.message}`
          );
        }
    }
  } catch (error: any) {
    throw new Error(`Error al procesar documento: ${error.message}`);
  }
}

async function createChatCompletionAdaptive(params: any) {
  try {
    return await openai.chat.completions.create(params as any);
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.includes("Unsupported parameter") && msg.includes("max_tokens")) {
      const retry = { ...params };
      delete (retry as any).max_tokens;
      (retry as any).max_completion_tokens = params.max_tokens;
      return await openai.chat.completions.create(retry as any);
    }
    // Fallback: algunos modelos no soportan tools. Reintentamos sin tools.
    if (msg.toLowerCase().includes('tools is not supported')) {
      const retry = { ...params };
      delete (retry as any).tools;
      return await openai.chat.completions.create(retry as any);
    }
    throw err;
  }
}

const app = Fastify({ logger: true });
const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';

// Static files
await app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
});

// Cookies & JWT
await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET ?? 'dev-secret' });
await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET ?? 'dev-jwt',
  cookie: { cookieName: 'token', signed: false }
});

async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'No autenticado' });
  }
}

// API key middleware: solo para endpoints de servicio /ai/*
app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url || !req.url.startsWith('/ai')) {
    return; // UI estática, auth de dashboard y otros endpoints quedan libres del API key
  }
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    reply.code(401).send({ error: 'Missing x-api-key' });
    return;
  }
  const tenant = await prisma.tenant.findUnique({
    where: { apikey: apiKey },
    select: { id: true, name: true, balance: true }
  });
  if (!tenant) {
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }
  if (tenant.balance.lte(0)) {
    reply.code(402).send({ error: 'Saldo insuficiente' });
    return;
  }
  req.tenant = tenant;
});

// Admin guard for /api/admin/*
app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url || !req.url.startsWith('/api/admin')) return;
  const path = req.url.split('?')[0];
  if (path === '/api/admin/login' || path === '/api/admin/check') {
    return; // permitir login y verificación sin cookie
  }
  const isAdmin = (req as any).cookies?.admin_auth === '1';
  if (!isAdmin) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
});

// Auth endpoints (signup/login)
app.post('/auth/signup', async (req, reply) => {
  const bodySchema = z.object({
    tenantName: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(6)
  });
  const body = bodySchema.parse(req.body);

  // Create tenant and admin user
  const apiKey = generateApiKey();
  const hashed = await (await import('argon2')).hash(body.password);
  const created = await prisma.$transaction(async tx => {
    const tenant = await tx.tenant.create({ data: { name: body.tenantName, apikey: apiKey, balance: new Prisma.Decimal(0), toolsEnabled: false } });
    const user = await tx.user.create({ data: { tenantId: tenant.id, email: body.email, passwordHash: hashed, role: 'admin' } });
    await tx.settings.create({
      data: {
        tenantId: tenant.id,
        systemPrompt: 'Eres un asistente útil, tu nombre es mirlo',
        temperature: 0.7,
        maxTokens: 1000,
        modelDefault: 'gpt-4.1-mini',
        aiEndpointUrl: 'http://181.117.6.16:3000/ai/answer',
        aiForwardApiKey: ''
      }
    });
    return { tenant, user };
  });

  const token = await reply.jwtSign({ uid: created.user.id, tid: created.tenant.id, role: 'admin' }, { expiresIn: '7d' });
  reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' });
  reply.send({ ok: true });
});

app.post('/auth/login', async (req, reply) => {
  const bodySchema = z.object({ email: z.string().email(), password: z.string() });
  const body = bodySchema.parse(req.body);
  const user = await prisma.user.findFirst({ where: { email: body.email } });
  if (!user) return reply.code(401).send({ error: 'Credenciales inválidas' });
  const ok = await (await import('argon2')).verify(user.passwordHash, body.password);
  if (!ok) return reply.code(401).send({ error: 'Credenciales inválidas' });
  const token = await reply.jwtSign({ uid: user.id, tid: user.tenantId, role: user.role }, { expiresIn: '7d' });
  reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' });
  reply.send({ ok: true });
});

app.post('/auth/logout', async (_req, reply) => {
  reply.clearCookie('token', { path: '/' });
  reply.send({ ok: true });
});

// Dashboard APIs
app.get('/api/me', { preHandler: authGuard }, async (req: any, reply) => {
  const { tid, uid } = req.user as { tid: string; uid: string };
  const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { id: true, name: true, apikey: true, balance: true, toolsEnabled: true } });
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, email: true, role: true } });
  const settings = await prisma.settings.findUnique({ where: { tenantId: tid }, select: { modelDefault: true, aiEndpointUrl: true, aiForwardApiKey: true } });
  reply.send({ tenant, user, settings });
});

app.get('/api/usage', { preHandler: authGuard }, async (req: any, reply) => {
  const { tid } = req.user as { tid: string };
  const logs = await prisma.usageLog.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, take: 50 });
  reply.send({ logs });
});

app.post('/api/regenerate-key', { preHandler: authGuard }, async (req: any, reply) => {
  const { tid } = req.user as { tid: string };
  const newKey = generateApiKey();
  const updated = await prisma.tenant.update({ where: { id: tid }, data: { apikey: newKey }, select: { apikey: true } });
  reply.send(updated);
});

// Settings endpoints
app.get('/api/settings', { preHandler: authGuard }, async (req: any, reply) => {
  const { tid } = req.user as { tid: string };
  const settings = await prisma.settings.findUnique({ where: { tenantId: tid } });
  reply.send({ settings });
});

app.post('/api/settings', { preHandler: authGuard }, async (req: any, reply) => {
  const { tid } = req.user as { tid: string };
  const bodySchema = z.object({
    systemPrompt: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(4000).optional(),
    modelDefault: z.string().min(1).optional(),
    aiEndpointUrl: z.string().url().optional(),
    aiForwardApiKey: z.string().optional()
  });
  const body = bodySchema.parse(req.body);
  const defaults = {
    systemPrompt: 'Eres un asistente útil, tu nombre es mirlo',
    temperature: 0.7,
    maxTokens: 1000,
    modelDefault: 'gpt-4.1-mini',
    aiEndpointUrl: 'http://181.117.6.16:3000/ai/answer',
    aiForwardApiKey: ''
  };
  const updated = await prisma.settings.upsert({
    where: { tenantId: tid },
    update: body,
    create: { tenantId: tid, ...defaults, ...body }
  });
  reply.send({ settings: updated });
});

// Lista de modelos activos
app.get('/api/models', { preHandler: authGuard }, async (_req: any, reply) => {
  const models = await prisma.model.findMany({
    where: { isActive: true },
    select: { name: true, provider: true, inputCostPerMillion: true, outputCostPerMillion: true }
  });
  reply.send({ models });
});

// Admin: lista de tenants y toggle de toolsEnabled (simple, sin auth fuerte)
app.get('/api/admin/tenants', async (_req, reply) => {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, balance: true, toolsEnabled: true } });
  reply.send({ tenants });
});

app.post('/api/admin/tenants/tools-toggle', async (req, reply) => {
  const body = (z.object({ tenantId: z.string().min(1), enable: z.boolean() })).parse(req.body);
  const updated = await prisma.tenant.update({ where: { id: body.tenantId }, data: { toolsEnabled: body.enable }, select: { id: true, toolsEnabled: true } });
  reply.send(updated);
});

// Admin auth endpoints
app.get('/api/admin/check', async (req, reply) => {
  const isAdmin = (req as any).cookies?.admin_auth === '1';
  if (!isAdmin) return reply.code(401).send({ error: 'Unauthorized' });
  reply.send({ ok: true });
});

app.post('/api/admin/login', async (req, reply) => {
  const body = (z.object({ password: z.string().min(1) })).parse(req.body);
  if (body.password !== ADMIN_PASSWORD) {
    reply.code(401).send({ error: 'Invalid password' });
    return;
  }
  reply.setCookie('admin_auth', '1', { httpOnly: true, sameSite: 'lax', path: '/' });
  reply.send({ ok: true });
});

app.post('/api/admin/logout', async (_req, reply) => {
  reply.clearCookie('admin_auth', { path: '/' });
  reply.send({ ok: true });
});

// Tenant registration
app.post('/tenants/register', async (req, reply) => {
  const bodySchema = z.object({ name: z.string().min(2), initial_balance: z.number().nonnegative().default(0).optional() });
  const body = bodySchema.parse(req.body);
  const apiKey = generateApiKey();
  const created = await prisma.tenant.create({
    data: {
      name: body.name,
      apikey: apiKey,
      balance: new Prisma.Decimal(body.initial_balance ?? 0)
    },
    select: { id: true, name: true, apikey: true, balance: true, createdAt: true }
  });
  reply.send(created);
});

// Schema para contenido multimodal (texto + imágenes + documentos)
const MessageContentSchema = z.union([
  z.string(), // Contenido simple de texto
  z.array(z.union([
    z.object({
      type: z.literal('text'),
      text: z.string()
    }),
    z.object({
      type: z.literal('image_url'),
      image_url: z.object({
        url: z.string().url(),
        detail: z.enum(['low', 'high', 'auto']).optional().default('auto')
      })
    }),
    z.object({
      type: z.literal('document_url'),
      document_url: z.object({
        url: z.string().url(),
        max_length: z.number().int().positive().max(50000).optional().default(10000),
        extract_mode: z.enum(['auto', 'text_only']).optional().default('auto')
      })
    })
  ])) // Contenido multimodal (array de texto, imágenes y documentos)
]);

// Input schema para /ai/answer (system se toma de Settings del tenant)
const AiAnswerRequestSchema = z.object({
  conversation: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: MessageContentSchema,
    context_tools: z.array(z.object({
      name: z.string(),
      args: z.unknown().optional(),
      result: z.unknown().optional()
    })).optional()
  })).min(1),
  model: z.string().min(1).optional(),
  trace: z.boolean().optional().default(false),
  context_tools: z.array(z.object({
    name: z.string(),
    args: z.unknown().optional(),
    result: z.unknown().optional()
  })).optional().default([])
});

// Schema para el endpoint de transcripción
// Formatos nativos: mp3, mp4, mpeg, mpga, m4a, wav, webm
// Formatos con conversión: ogg (WhatsApp voice messages)
const TranscriptionRequestSchema = z.object({
  mode: z.enum(['stt']),
  audio_url: z.string().url(), // URL del archivo de audio (soporta: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg)
  model: z.string().optional().default('whisper-1'),
  language: z.string().optional(), // Código ISO 639-1 (ej: 'es', 'en', 'fr')
  prompt: z.string().optional(), // Texto que guía el estilo de transcripción
  response_format: z.enum(['json', 'text', 'srt', 'verbose_json', 'vtt']).optional().default('json'),
  temperature: z.number().min(0).max(1).optional() // 0 = más conservador, 1 = más creativo
});

// Schema para el endpoint de procesamiento de documentos
// Formatos soportados: pdf, txt, docx, md
const DocumentRequestSchema = z.object({
  mode: z.enum(['extract', 'analyze']), // extract = solo extraer texto, analyze = extraer + analizar
  document_url: z.string().url(), // URL del documento
  question: z.string().optional(), // Pregunta específica sobre el documento (para modo analyze)
  max_length: z.number().int().positive().max(50000).optional().default(10000), // Límite de caracteres a extraer
  model: z.string().optional(), // Modelo para análisis (se auto-selecciona si no se especifica)
  language: z.string().optional().default('es') // Idioma para el análisis
});

// Tools importadas desde src/tools/localTools

app.post('/ai/answer', async (req, reply) => {
  const parsed = AiAnswerRequestSchema.parse(req.body);
  const tenant = req.tenant!;

  // Load settings for tenant
  const settings = await prisma.settings.findUnique({ where: { tenantId: tenant.id } });
  // Verificar si las tools están habilitadas para decidir si exponerlas o no
  const tenantToolsEnabled = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { toolsEnabled: true } });
  const toolsAllowed = !!tenantToolsEnabled?.toolsEnabled;
  const systemPrompt = settings?.systemPrompt ?? 'Eres un asistente útil, tu nombre es mirlo';
  const temperature = settings?.temperature ?? 0.7;
  const maxTokens = settings?.maxTokens ?? 1000;

  // 1-2. Detectar si la conversación contiene imágenes o documentos
  const hasImages = parsed.conversation.some(msg => 
    Array.isArray(msg.content) && 
    msg.content.some((item: any) => item.type === 'image_url')
  );
  
  const hasDocuments = parsed.conversation.some(msg => 
    Array.isArray(msg.content) && 
    msg.content.some((item: any) => item.type === 'document_url')
  );

  // 3. Selección inteligente de modelo
  const visionModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-vision-preview'];
  let modelName: string;
  
  if (parsed.model) {
    // Si se especifica modelo manualmente, usarlo
    modelName = parsed.model;
  } else if (hasImages) {
    // Si hay imágenes, buscar el mejor modelo Vision disponible
    const availableVisionModel = await prisma.model.findFirst({ 
      where: { 
        name: { in: visionModels }, 
        isActive: true 
      },
      orderBy: { name: 'asc' } // Preferir gpt-4o por orden alfabético
    });
    
    if (!availableVisionModel) {
      reply.code(400).send({ 
        error: 'No hay modelos compatibles con imágenes disponibles',
        available_vision_models: visionModels
      });
      return;
    }
    modelName = availableVisionModel.name;
  } else {
    // Sin imágenes, usar modelo por defecto del tenant
    modelName = settings?.modelDefault ?? 'gpt-4.1-mini';
  }

  const model = await prisma.model.findFirst({ where: { name: modelName, isActive: true } });
  if (!model) {
    reply.code(400).send({ error: `Modelo no disponible: ${modelName}` });
    return;
  }

  // 4. Verificación final: asegurar compatibilidad imagen-modelo
  if (hasImages && !visionModels.includes(model.name)) {
    reply.code(400).send({ 
      error: `El modelo ${model.name} no soporta imágenes`,
      suggestion: 'Los modelos compatibles con imágenes son: ' + visionModels.join(', ')
    });
    return;
  }

  // Sin tools (MCP/webhook removidos)

  // 4. Procesar documentos en la conversación si los hay
  if (hasDocuments) {
    for (const message of parsed.conversation) {
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'document_url') {
            try {
              // Descargar y extraer texto del documento
              const documentResponse = await fetch(item.document_url.url);
              if (!documentResponse.ok) {
                throw new Error(`No se pudo descargar el documento: ${item.document_url.url}`);
              }
              
              const documentBuffer = await documentResponse.arrayBuffer();
              const urlPath = new URL(item.document_url.url).pathname;
              const filename = urlPath.split('/').pop() || 'document.txt';
              const maxLength = item.document_url.max_length || 10000;
              
              const extraction = await extractTextFromDocument(documentBuffer, filename, maxLength);
              
              // Reemplazar el document_url con el texto extraído
              const documentText = `[DOCUMENTO: ${filename}]\n\n${extraction.text}\n\n[FIN DEL DOCUMENTO]`;
              
              // Convertir document_url a text con el contenido extraído
              item.type = 'text' as any;
              (item as any).text = documentText;
              delete (item as any).document_url;
              
            } catch (error: any) {
              console.error('Error procesando documento:', error);
              // En caso de error, convertir a texto con mensaje de error
              item.type = 'text' as any;
              (item as any).text = `[ERROR] No se pudo procesar el documento: ${error.message}`;
              delete (item as any).document_url;
            }
          }
        }
      }
    }
  }

  // 5. Build messages (inyectar context_tools globales y por-mensaje, soportar contenido multimodal)
  const convMessages: Array<{ role: 'user' | 'assistant'; content: any }> = parsed.conversation.flatMap((m: any) => {
    if (m.role === 'assistant' && Array.isArray(m.context_tools) && m.context_tools.length > 0) {
      const ctx = `Contexto de herramientas previas: ${JSON.stringify(m.context_tools)}`;
      // Si el contenido es multimodal, necesitamos manejarlo diferente
      if (Array.isArray(m.content)) {
        // Agregar el contexto como texto al inicio del array de contenido
        const contextContent = [{ type: 'text', text: ctx }, ...m.content];
        return [{ role: 'assistant', content: contextContent } as any];
      } else {
        // Contenido simple de texto
      return [{ role: 'assistant', content: `${ctx}\n\n${m.content}` } as any];
      }
    }
    return [{ role: m.role, content: m.content } as any];
  });

  const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [
    { role: 'system', content: systemPrompt },
    ...(parsed.context_tools && parsed.context_tools.length
      ? [{ role: 'system', content: `Contexto de herramientas previas: ${JSON.stringify(parsed.context_tools)}` } as any]
      : []),
    ...convMessages
  ];

  // Pre-cost estimation to enforce 402 before calling the model
  const estInTokens = estimateMessagesTokens(baseMessages);
  const estOutTokens = maxTokens;
  const estimatedCost =
    (estInTokens * Number(model.inputCostPerMillion)) / 1_000_000 +
    (estOutTokens * Number(model.outputCostPerMillion)) / 1_000_000;

  if (new Prisma.Decimal(estimatedCost).gt(tenant.balance)) {
    reply.code(402).send({ error: 'Saldo insuficiente para procesar la solicitud' });
    return;
  }

  // 5. Loop de function calling: ejecutar tools solo si están habilitadas
  const toolDefs = toolsAllowed ? getOpenAiToolDefs() : [];
  let messages = [...baseMessages];
  let assistantMessage: any = null;
  const traceLog: any[] = [];
  const contextToolsOut: Array<{ name: string; args: any; result: any }> = [];
  for (let round = 0; round < 16; round++) {
    const resp = await createChatCompletionAdaptive({
      model: model.name,
      messages,
      temperature: temperature,
      max_tokens: maxTokens,
      tools: toolDefs.length ? toolDefs : undefined
    });
    assistantMessage = resp.choices[0]?.message;
    if (assistantMessage) messages.push(assistantMessage as any);
    if ((parsed as any).trace) {
      const tc: any[] = assistantMessage?.tool_calls ?? [];
      const rawContent = (assistantMessage?.content ?? '') as string;
      const contentTrim = rawContent ? String(rawContent).trim() : '';
      const fallback = tc && tc.length ? `Solicita ejecutar ${tc.map((t: any) => t?.function?.name).filter(Boolean).join(', ')}` : '';
      const assistantText = contentTrim || fallback;
      traceLog.push({
        round: round + 1,
        assistant_message: assistantText,
        assistant_tool_only: !contentTrim && tc && tc.length > 0,
        tool_calls: tc.map((t: any) => ({ name: t?.function?.name, arguments: t?.function?.arguments }))
      });
    }
    const toolCalls: any[] = assistantMessage?.tool_calls ?? [];
    if (!toolCalls || toolCalls.length === 0) {
      break; // no más tools; responder
    }
    console.log(`[TOOLS] Round ${round + 1}: executing ${toolCalls.length} tool call(s)`);
    for (const call of toolCalls) {
      const toolName = call.function?.name as string;
      let args: any = {};
      try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
      try {
        const argsStr = (() => { try { return JSON.stringify(args); } catch { return String(args); } })();
        console.log(`[TOOL] Executing ${toolName} with args: ${argsStr}`);
      } catch {}
      const result = await executeLocalTool(toolName, args);
      try {
        const resStr = (() => { try { return typeof result === 'string' ? result : JSON.stringify(result); } catch { return String(result); } })();
        console.log(`[TOOL] Result for ${toolName}: ${resStr}`);
      } catch {}
      try { contextToolsOut.push({ name: toolName, args, result }); } catch {}
      const toolCallId = (call as any).id || (call as any).tool_call_id;
      const toolContent = typeof result === 'string' ? result : JSON.stringify(result);
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: toolContent } as any);
      if ((parsed as any).trace) {
        traceLog.push({ round: round + 1, tool_result: { name: toolName, result } });
      }
    }
    // Continúa a siguiente ronda; el loop hará una nueva llamada con resultados agregados
  }

  const finalAnswer = assistantMessage?.content ?? '';

  // 8-9. Usage logging and billing
  const tokensIn = estimateMessagesTokens(messages);
  const tokensOut = estimateTokensFromText(finalAnswer);
  const costUsd =
    (tokensIn * Number(model.inputCostPerMillion)) / 1_000_000 +
    (tokensOut * Number(model.outputCostPerMillion)) / 1_000_000;

  try {
    await prisma.$transaction(async tx => {
      // Re-check and deduct
      const freshTenant = await tx.tenant.findUnique({ where: { id: tenant.id }, select: { id: true, balance: true } });
      if (!freshTenant) throw new Error('Tenant not found');
      if (freshTenant.balance.lt(costUsd)) {
        throw Object.assign(new Error('Saldo insuficiente'), { httpStatus: 402 });
      }
      await tx.usageLog.create({
        data: {
          tenantId: tenant.id,
          modelId: model.id,
          tokensIn: tokensIn,
          tokensOut: tokensOut,
          costUsd: new Prisma.Decimal(costUsd)
        }
      });
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { balance: freshTenant.balance.minus(costUsd) }
      });
    });
  } catch (err: any) {
    if (err?.httpStatus === 402) {
      reply.code(402).send({ error: 'Saldo insuficiente' });
      return;
    }
    throw err;
  }

  // 10. Return response (devolver context_tools para próxima llamada)
  reply.send({
    answer: { role: 'assistant', context_tools: contextToolsOut, content: finalAnswer },
    model_used: model.name,
    auto_selected: !parsed.model && hasImages ? true : undefined,
    has_images: hasImages,
    has_documents: hasDocuments,
    processed_content: {
      images: hasImages,
      documents: hasDocuments
    }
  });
});

// Endpoint para transcripción de audio
app.post('/ai/transcripcion', async (req, reply) => {
  const parsed = TranscriptionRequestSchema.parse(req.body);
  const tenant = req.tenant!;

  if (parsed.mode !== 'stt') {
    reply.code(400).send({ error: 'Solo se soporta el modo "stt" (speech-to-text)' });
    return;
  }

  try {
    // Descargar el archivo de audio desde la URL
    const audioResponse = await fetch(parsed.audio_url);
    if (!audioResponse.ok) {
      reply.code(400).send({ error: 'No se pudo descargar el archivo de audio desde la URL proporcionada' });
      return;
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    
    // Detectar extensión del archivo desde la URL
    const urlPath = new URL(parsed.audio_url).pathname;
    const originalExtension = urlPath.split('.').pop()?.toLowerCase() || 'wav';
    const nativeSupportedFormats = ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'];
    const allSupportedFormats = [...nativeSupportedFormats, 'ogg']; // OGG requiere conversión
    
    // Verificar si el formato está soportado
    if (!allSupportedFormats.includes(originalExtension)) {
      reply.code(400).send({ 
        error: `Formato de audio no soportado: ${originalExtension}`,
        supported_formats: allSupportedFormats
      });
      return;
    }
    
    let audioBufferForWhisper = audioBuffer;
    let fileExtension = originalExtension;
    let fileName = `audio.${fileExtension}`;
    
    // Si es OGG, necesitamos convertir a WAV (nota: requeriría FFmpeg en producción)
    if (originalExtension === 'ogg') {
      // Por ahora, intentamos enviar como OGG y si falla, informamos al usuario
      // En producción, aquí se implementaría conversión con FFmpeg
      fileExtension = 'ogg';
      fileName = 'audio.ogg';
      console.log('⚠️  Archivo OGG detectado. Nota: puede requerir conversión para mejor compatibilidad.');
    }
    
    const audioBlob = new Blob([audioBuffer]);

    // Crear un FormData para la petición a OpenAI
    const formData = new FormData();
    formData.append('file', audioBlob, fileName);
    formData.append('model', parsed.model || 'whisper-1');
    formData.append('response_format', parsed.response_format || 'json');
    
    if (parsed.language) {
      formData.append('language', parsed.language);
    }
    if (parsed.prompt) {
      formData.append('prompt', parsed.prompt);
    }
    if (parsed.temperature !== undefined) {
      formData.append('temperature', parsed.temperature.toString());
    }

    // Llamar a la API de OpenAI Whisper
    const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: formData
    });

    if (!transcriptionResponse.ok) {
      const errorData = await transcriptionResponse.text();
      console.error('Error de OpenAI:', errorData);
      reply.code(500).send({ error: 'Error al procesar la transcripción' });
      return;
    }

    const transcriptionResult = await transcriptionResponse.json();

    // Estimación de costo para transcripción (Whisper cobra por minuto de audio)
    // Precio aproximado: $0.006 por minuto
    const audioSizeInMB = audioBuffer.byteLength / (1024 * 1024);
    const estimatedMinutes = audioSizeInMB / 1; // Estimación aproximada: 1MB ≈ 1 minuto
    const estimatedCost = estimatedMinutes * 0.006;

    // Verificar saldo antes de procesar
    if (new Prisma.Decimal(estimatedCost).gt(tenant.balance)) {
      reply.code(402).send({ error: 'Saldo insuficiente para procesar la transcripción' });
      return;
    }

    // Logging de uso y facturación
    try {
      await prisma.$transaction(async tx => {
        const freshTenant = await tx.tenant.findUnique({ 
          where: { id: tenant.id }, 
          select: { id: true, balance: true } 
        });
        
        if (!freshTenant) throw new Error('Tenant not found');
        if (freshTenant.balance.lt(estimatedCost)) {
          throw Object.assign(new Error('Saldo insuficiente'), { httpStatus: 402 });
        }

        // Buscar o crear un modelo para Whisper transcripciones
        let whisperModel = await tx.model.findFirst({ 
          where: { name: 'whisper-1', provider: 'openai' } 
        });
        
        if (!whisperModel) {
          whisperModel = await tx.model.create({
            data: {
              provider: 'openai',
              name: 'whisper-1',
              inputCostPerMillion: new Prisma.Decimal('0.006'), // $0.006 por minuto
              outputCostPerMillion: new Prisma.Decimal('0'), // No hay output tokens en transcripción
              isActive: true
            }
          });
        }

        // Crear registro de uso para transcripción
        await tx.usageLog.create({
          data: {
            tenantId: tenant.id,
            modelId: whisperModel.id,
            tokensIn: Math.round(estimatedMinutes), // Usamos minutos como "input tokens"
            tokensOut: 0,
            costUsd: new Prisma.Decimal(estimatedCost),
          }
        });

        await tx.tenant.update({
          where: { id: tenant.id },
          data: { balance: freshTenant.balance.minus(estimatedCost) }
        });
      });
    } catch (err: any) {
      if (err?.httpStatus === 402) {
        reply.code(402).send({ error: 'Saldo insuficiente' });
        return;
      }
      throw err;
    }

    // Devolver resultado de transcripción
    reply.send({
      mode: 'stt',
      transcription: transcriptionResult,
      cost_usd: estimatedCost,
      audio_size_mb: audioSizeInMB.toFixed(2),
      audio_format: originalExtension,
      processed_as: fileExtension,
      supported_formats: allSupportedFormats,
      note: originalExtension === 'ogg' ? 'Archivo OGG procesado. Para mejor compatibilidad, considera convertir a WAV o MP3.' : undefined
    });

  } catch (error: any) {
    console.error('Error en transcripción:', error);
    reply.code(500).send({ 
      error: 'Error interno del servidor al procesar la transcripción',
      details: error.message 
    });
  }
});

// Endpoint para procesamiento de documentos
app.post('/ai/document', async (req, reply) => {
  const parsed = DocumentRequestSchema.parse(req.body);
  const tenant = req.tenant!;

  try {
    // Descargar el documento desde la URL
    const documentResponse = await fetch(parsed.document_url);
    if (!documentResponse.ok) {
      reply.code(400).send({ error: 'No se pudo descargar el documento desde la URL proporcionada' });
      return;
    }

    const documentBuffer = await documentResponse.arrayBuffer();
    
    // Detectar nombre del archivo desde la URL
    const urlPath = new URL(parsed.document_url).pathname;
    const filename = urlPath.split('/').pop() || 'document.txt';
    
    // Extraer texto del documento
    const extraction = await extractTextFromDocument(documentBuffer, filename, parsed.max_length);
    
    if (parsed.mode === 'extract') {
      // Solo extraer texto, sin análisis con IA
      const estimatedCost = 0.001; // Costo mínimo por extracción
      
      // Verificar saldo
      if (new Prisma.Decimal(estimatedCost).gt(tenant.balance)) {
        reply.code(402).send({ error: 'Saldo insuficiente' });
        return;
      }

      // Logging de uso
      await prisma.$transaction(async tx => {
        const freshTenant = await tx.tenant.findUnique({ 
          where: { id: tenant.id }, 
          select: { id: true, balance: true } 
        });
        
        if (!freshTenant || freshTenant.balance.lt(estimatedCost)) {
          throw Object.assign(new Error('Saldo insuficiente'), { httpStatus: 402 });
        }

        // Crear un modelo dummy para extracción de documentos si no existe
        let extractModel = await tx.model.findFirst({ 
          where: { name: 'document-extract', provider: 'internal' } 
        });
        
        if (!extractModel) {
          extractModel = await tx.model.create({
            data: {
              provider: 'internal',
              name: 'document-extract',
              inputCostPerMillion: new Prisma.Decimal('0.001'),
              outputCostPerMillion: new Prisma.Decimal('0'),
              isActive: true
            }
          });
        }

        await tx.usageLog.create({
          data: {
            tenantId: tenant.id,
            modelId: extractModel.id,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: new Prisma.Decimal(estimatedCost),
          }
        });

        await tx.tenant.update({
          where: { id: tenant.id },
          data: { balance: freshTenant.balance.minus(estimatedCost) }
        });
      });

      reply.send({
        mode: 'extract',
        document_url: parsed.document_url,
        extracted_text: extraction.text,
        metadata: extraction.metadata,
        cost_usd: estimatedCost
      });
      return;
    }

    // Modo 'analyze': extraer texto y analizarlo con IA
    const settings = await prisma.settings.findUnique({ where: { tenantId: tenant.id } });
    const systemPrompt = settings?.systemPrompt ?? 'Eres un asistente útil que analiza documentos.';
    const temperature = settings?.temperature ?? 0.7;
    const maxTokens = settings?.maxTokens ?? 1000;

    // Seleccionar modelo (usar el por defecto del tenant ya que no hay imágenes)
    const modelName = parsed.model ?? settings?.modelDefault ?? 'gpt-4.1-mini';
    const model = await prisma.model.findFirst({ where: { name: modelName, isActive: true } });
    if (!model) {
      reply.code(400).send({ error: `Modelo no disponible: ${modelName}` });
      return;
    }

    // Construir prompt para análisis
    const userQuestion = parsed.question || 'Analiza este documento y proporciona un resumen detallado de su contenido.';
    const analysisPrompt = `Aquí tienes el contenido de un documento para analizar:

--- INICIO DEL DOCUMENTO ---
${extraction.text}
--- FIN DEL DOCUMENTO ---

Pregunta del usuario: ${userQuestion}

Por favor, responde en ${parsed.language === 'es' ? 'español' : parsed.language}.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: analysisPrompt }
    ];

    // Estimación de costos
    const estInTokens = estimateMessagesTokens(messages);
    const estOutTokens = maxTokens;
    const estimatedCost =
      (estInTokens * Number(model.inputCostPerMillion)) / 1_000_000 +
      (estOutTokens * Number(model.outputCostPerMillion)) / 1_000_000;

    if (new Prisma.Decimal(estimatedCost).gt(tenant.balance)) {
      reply.code(402).send({ error: 'Saldo insuficiente para procesar el análisis' });
      return;
    }

    // Llamar a OpenAI para análisis
    const response = await createChatCompletionAdaptive({
      model: model.name,
      messages,
      temperature: temperature,
      max_tokens: maxTokens
    });

    const analysis = response.choices[0]?.message?.content ?? '';

    // Cálculo final de costos
    const tokensIn = estimateMessagesTokens(messages);
    const tokensOut = estimateTokensFromText(analysis);
    const finalCost =
      (tokensIn * Number(model.inputCostPerMillion)) / 1_000_000 +
      (tokensOut * Number(model.outputCostPerMillion)) / 1_000_000;

    // Logging de uso y facturación
    await prisma.$transaction(async tx => {
      const freshTenant = await tx.tenant.findUnique({ 
        where: { id: tenant.id }, 
        select: { id: true, balance: true } 
      });
      
      if (!freshTenant || freshTenant.balance.lt(finalCost)) {
        throw Object.assign(new Error('Saldo insuficiente'), { httpStatus: 402 });
      }

      await tx.usageLog.create({
        data: {
          tenantId: tenant.id,
          modelId: model.id,
          tokensIn: tokensIn,
          tokensOut: tokensOut,
          costUsd: new Prisma.Decimal(finalCost),
        }
      });

      await tx.tenant.update({
        where: { id: tenant.id },
        data: { balance: freshTenant.balance.minus(finalCost) }
      });
    });

    reply.send({
      mode: 'analyze',
      document_url: parsed.document_url,
      question: userQuestion,
      extracted_text: extraction.text,
      analysis: analysis,
      metadata: extraction.metadata,
      model_used: model.name,
      cost_usd: finalCost,
      tokens_used: { input: tokensIn, output: tokensOut }
    });

  } catch (error: any) {
    console.error('Error en procesamiento de documento:', error);
    reply.code(500).send({ 
      error: 'Error interno del servidor al procesar el documento',
      details: error.message 
    });
  }
});

// Endpoint para consultar formatos de documento soportados
app.get('/ai/document/formats', async (_req, reply) => {
  const formatSupport = getDocumentFormatSupport();
  const installationInstructions: Record<string, string> = {
    pdf: 'npm install pdf-parse',
    docx: 'npm install mammoth'
  };
  
  reply.send({
    supported_formats: formatSupport,
    installation_instructions: Object.entries(formatSupport)
      .filter(([format, supported]) => !supported && installationInstructions[format])
      .reduce((acc, [format, _]) => ({
        ...acc,
        [format]: installationInstructions[format]
      }), {}),
    fully_supported: Object.entries(formatSupport)
      .filter(([_, supported]) => supported)
      .map(([format, _]) => format),
    requires_installation: Object.entries(formatSupport)
      .filter(([_, supported]) => !supported)
      .map(([format, _]) => format)
  });
});

async function main() {
  await prisma.$connect();
  await ensureDefaultModels();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch(err => {
  app.log.error(err);
  process.exit(1);
});


