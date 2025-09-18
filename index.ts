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

// MCP eliminado completamente

// Very rough token estimator: ~4 chars per token
function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const chars = [...text].length;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((sum, m) => sum + estimateTokensFromText(m.content), 0);
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
      }
    ]
  });
}

function generateApiKey(): string {
  return randomUUID().replace(/-/g, '') + Math.random().toString(16).slice(2);
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

// Input schema para /ai/answer (system se toma de Settings del tenant)
const AiAnswerRequestSchema = z.object({
  conversation: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
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

  // 1-2. Validate model (use settings default if not provided)
  const modelName = parsed.model ?? settings?.modelDefault ?? 'gpt-4.1-mini';
  const model = await prisma.model.findFirst({ where: { name: modelName, isActive: true } });
  if (!model) {
    reply.code(400).send({ error: 'Modelo no disponible' });
    return;
  }

  // Sin tools (MCP/webhook removidos)

  // 4. Build messages (inyectar context_tools globales y por-mensaje)
  const convMessages: Array<{ role: 'user' | 'assistant'; content: string }> = parsed.conversation.flatMap((m: any) => {
    if (m.role === 'assistant' && Array.isArray(m.context_tools) && m.context_tools.length > 0) {
      const ctx = `Contexto de herramientas previas: ${JSON.stringify(m.context_tools)}`;
      return [{ role: 'assistant', content: `${ctx}\n\n${m.content}` } as any];
    }
    return [{ role: m.role, content: m.content } as any];
  });

  const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
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
    answer: { role: 'assistant', context_tools: contextToolsOut, content: finalAnswer }
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


