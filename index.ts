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

// Minimal MCP HTTP-like adapter (JSON-RPC over HTTP convention)
type McpTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

async function mcpListTools(serverUrl: string, headers: Record<string, string> = {}): Promise<McpTool[]> {
  try {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} })
    });
    const json = await res.json();
    return json?.result?.tools ?? [];
  } catch {
    return [];
  }
}

async function mcpCallTool(serverUrl: string, toolName: string, args: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${serverUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: toolName, arguments: args } })
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message ?? 'MCP tool call failed');
  }
  return json.result;
}

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
    throw err;
  }
}

const app = Fastify({ logger: true });
const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const tenant = await tx.tenant.create({ data: { name: body.tenantName, apikey: apiKey, balance: new Prisma.Decimal(0) } });
    const user = await tx.user.create({ data: { tenantId: tenant.id, email: body.email, passwordHash: hashed, role: 'admin' } });
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
  const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { id: true, name: true, apikey: true, balance: true } });
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, email: true, role: true } });
  reply.send({ tenant, user });
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

// Input schema for /ai/answer
const AiAnswerRequestSchema = z.object({
  system: z.object({ prompt: z.string().min(1), policies: z.object({ temperature: z.number().min(0).max(2).default(0.2), max_tokens: z.number().int().positive().max(4000).default(500) }) }),
  conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1),
  mcp_servers: z.array(z.object({ name: z.string(), url: z.string().url(), headers: z.record(z.string()).optional() })).default([]),
  model: z.string().min(1)
});

app.post('/ai/answer', async (req, reply) => {
  const parsed = AiAnswerRequestSchema.parse(req.body);
  const tenant = req.tenant!;

  // 1-2. Validate model
  const model = await prisma.model.findFirst({ where: { name: parsed.model, isActive: true } });
  if (!model) {
    reply.code(400).send({ error: 'Modelo no disponible' });
    return;
  }

  // 3. Discover MCP tools
  const allTools: McpTool[] = [];
  for (const srv of parsed.mcp_servers) {
    const tools = await mcpListTools(srv.url, srv.headers ?? {});
    allTools.push(...tools.map(t => ({ ...t, name: `${srv.name}.${t.name}` })));
  }

  // 4. Build messages
  const baseMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: parsed.system.prompt },
    ...parsed.conversation
  ];

  // Pre-cost estimation to enforce 402 before calling the model
  const estInTokens = estimateMessagesTokens(baseMessages);
  const estOutTokens = parsed.system.policies.max_tokens;
  const estimatedCost =
    (estInTokens * Number(model.inputCostPerMillion)) / 1_000_000 +
    (estOutTokens * Number(model.outputCostPerMillion)) / 1_000_000;

  if (new Prisma.Decimal(estimatedCost).gt(tenant.balance)) {
    reply.code(402).send({ error: 'Saldo insuficiente para procesar la solicitud' });
    return;
  }

  // 5. Call OpenAI with tools
  const toolDefs = allTools.slice(0, 64).map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? 'Tool',
      parameters: t.input_schema ?? { type: 'object', properties: {}, additionalProperties: true }
    }
  }));

  const first = await createChatCompletionAdaptive({
    model: model.name,
    messages: baseMessages,
    temperature: parsed.system.policies.temperature,
    max_tokens: parsed.system.policies.max_tokens,
    tools: toolDefs.length ? toolDefs : undefined
  });

  let messages = [...baseMessages];
  let assistantMessage = first.choices[0]?.message;
  let toolCalls = assistantMessage?.tool_calls ?? [];

  if (toolCalls && toolCalls.length > 0) {
    // 6. Execute tool calls
    for (const call of toolCalls) {
      const name = call.function?.name as string;
      const [serverName, toolLocal] = name.split('.', 2);
      const srv = parsed.mcp_servers.find(s => s.name === serverName);
      if (!srv) continue;
      const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      const result = await mcpCallTool(srv.url, toolLocal, args, srv.headers ?? {});
      messages.push({ role: 'tool', content: JSON.stringify({ tool: name, result }) } as any);
    }
    // 7. Final response after tools
    const second = await createChatCompletionAdaptive({
      model: model.name,
      messages,
      temperature: parsed.system.policies.temperature,
      max_tokens: parsed.system.policies.max_tokens
    });
    assistantMessage = second.choices[0]?.message;
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

  // 10. Return response
  reply.send({
    answer: { role: 'assistant', content: finalAnswer },
    tool_calls: toolCalls
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


