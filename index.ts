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
import EventSource from 'eventsource';
import { Agent } from 'node:https';

// Minimal MCP HTTP-like adapter (JSON-RPC over HTTP convention)
type McpTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

function buildMcpCandidates(rawUrl: string): string[] {
  const urls: string[] = [];
  // If user passed an SSE endpoint, try common HTTP RPC fallbacks
  if (rawUrl.endsWith('/sse')) {
    const origin = rawUrl.replace(/\/?sse$/, '');
    urls.push(origin + '/mcp');
    urls.push(origin + '/messages');
    urls.push(origin);
  } else {
    urls.push(rawUrl + '/mcp');
    urls.push(rawUrl);
  }
  // Deduplicate
  return [...new Set(urls)];
}

function isSseUrl(url: string): boolean {
  return /\/?sse$/.test(url);
}

// Shared agent para reutilizar conexiones
const httpsAgent = new Agent({
  keepAlive: true,
  maxSockets: 1,
  timeout: 60000
});

// Keep SSE alive approach
async function mcpHttpOnlyRequest(serverUrl: string, body: any, headers: Record<string, string>) {
  const requestId = body?.id ?? randomUUID();
  // Don't convert number IDs to strings
  if (typeof requestId !== 'number') {
    body = { ...body, id: String(requestId) };
  }
  const base = serverUrl.replace(/\/?sse$/, '');
  
  return new Promise<any>((resolve, reject) => {
    let sessionId: string | null = null;
    let messagesUrl: string | null = null;
    let initSent = false;
    let mainSent = false;
    let initId: string | null = null;
    
    // Single SSE connection for the entire process
    const es = new EventSource(serverUrl, { headers } as any);
    
    const cleanup = () => {
      try { es.close(); } catch {}
    };
    
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('MCP timeout'));
    }, 30000);
    
    const sendMainRequest = async () => {
      if (mainSent || !messagesUrl) return;
      mainSent = true;
      
      try {
        console.log('[MCP] Sending main request with ID: 2');
        console.log('[MCP] Request body:', JSON.stringify(body));
        await fetch(messagesUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
          agent: messagesUrl.startsWith('https:') ? httpsAgent : undefined
        });
        console.log('[MCP] Main request sent, waiting for response...');
      } catch (e) {
        console.log('[MCP] Error sending main request:', e);
        cleanup();
        clearTimeout(timeout);
        reject(e);
      }
    };

    const sendRequests = async () => {
      if (!messagesUrl || initSent) return;
      initSent = true;
      
      try {
        // 1) Initialize
        initId = `init-${requestId}`;
        const initBody = {
          jsonrpc: '2.0',
          id: 1, // número, no string
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'test', version: '0.1.0' }, // Restaurar version - es requerido
            capabilities: { tools: {} }
          }
        };
        
        console.log('[MCP] Sending initialize request with ID:', initId);
        await fetch(messagesUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(initBody),
          agent: messagesUrl.startsWith('https:') ? httpsAgent : undefined
        });
        
        console.log('[MCP] Initialize request sent, waiting for response...');
        // NO enviamos main request aquí - esperamos respuesta de initialize
        
      } catch (e) {
        console.log('[MCP] Error sending initialize:', e);
        cleanup();
        clearTimeout(timeout);
        reject(e);
      }
    };
    
    // Handle endpoint event
    es.addEventListener('endpoint', (ev: any) => {
      try {
        const path = typeof ev?.data === 'string' ? ev.data : ev?.data?.toString?.() ?? '';
        if (path && path.includes('/messages/')) {
          messagesUrl = base + (path.startsWith('/') ? path : '/' + path);
          const match = path.match(/session_id=([^&\s]+)/);
          if (match) sessionId = match[1];
          void sendRequests();
        }
      } catch {}
    });
    
    // Handle message responses
    es.onmessage = (ev: any) => {
      try {
        console.log('[MCP] SSE message received:', ev.data);
        const json = JSON.parse(ev.data);
        
        // Initialize response - now send main request
        if (json?.id === 1) { // Match static ID
          console.log('[MCP] Initialize response received, sending main request');
          void sendMainRequest();
          return;
        }
        
        // Main response (number ID)
        if (json?.id === 2) { // Match número ID for tools/list
          console.log('[MCP] Main response received');
          cleanup();
          clearTimeout(timeout);
          resolve(json);
          return;
        }
        
        // Generic response fallback
        if (json?.result !== undefined || json?.error !== undefined) {
          console.log('[MCP] Generic response received');
          cleanup();
          clearTimeout(timeout);
          resolve(json);
        }
      } catch (e) {
        console.log('[MCP] Error parsing SSE message:', e);
      }
    };
    
    es.onerror = () => {
      // Keep connection open for transient errors
    };
  });
}

async function mcpSseRequest(serverSseUrl: string, body: any, headers: Record<string, string>) {
  // Try simplified HTTP-only approach first
  return mcpHttpOnlyRequest(serverSseUrl, body, headers);
}

async function mcpRpcTry(candidates: string[], body: any, headers: Record<string, string>) {
  let lastError: any;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const json = await res.json();
      if (json?.result !== undefined || json?.error) return json;
      lastError = new Error('Invalid MCP JSON-RPC response');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('All MCP endpoints failed');
}

async function mcpListTools(serverUrl: string, headers: Record<string, string> = {}, mode: 'sse' | 'http' = 'sse'): Promise<McpTool[]> {
  try {
    if (mode === 'http') {
      // Direct HTTP JSON-RPC (no SSE)
      const baseUrl = serverUrl.replace(/\/?sse$/, '');
      const endpoints = [baseUrl + '/rpc', baseUrl + '/', baseUrl + '/jsonrpc', baseUrl];
      
      // 1. Initialize first (required for your server)
      try {
        await mcpRpcTry(endpoints, {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'ai-orchestrator', version: '0.1.0' },
            capabilities: { tools: {} }
          }
        }, headers);
        console.log('[MCP-HTTP] Initialized successfully');
      } catch (e) {
        console.log('[MCP-HTTP] Initialize failed:', e);
      }
      
      // 2. List tools
      const json = await mcpRpcTry(endpoints, { 
        jsonrpc: '2.0', 
        id: 2,
        method: 'tools/list',
        params: {}
      }, headers);
      return json?.result?.tools ?? [];
    }
    
    if (isSseUrl(serverUrl)) {
      // SSE mode (existing logic)
      let json;
      try {
        json = await mcpSseRequest(serverUrl, { 
          jsonrpc: '2.0', 
          id: 2,
          method: 'tools/list'
          // No params field at all
        }, headers);
      } catch (e) {
        // Fallback: try with empty params
        json = await mcpSseRequest(serverUrl, { 
          jsonrpc: '2.0', 
          id: 2,
          method: 'tools/list',
          params: {}
        }, headers);
      }
      return json?.result?.tools ?? [];
    }
    const candidates = buildMcpCandidates(serverUrl);
    const json = await mcpRpcTry(candidates, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} }, headers);
    return json?.result?.tools ?? [];
  } catch {
    return [];
  }
}

async function mcpCallTool(serverUrl: string, toolName: string, args: unknown, headers: Record<string, string> = {}, mode: 'sse' | 'http' = 'sse'): Promise<unknown> {
  if (mode === 'http') {
    // Direct HTTP JSON-RPC (no SSE)
    const baseUrl = serverUrl.replace(/\/?sse$/, '');
    const endpoints = [baseUrl + '/rpc', baseUrl + '/', baseUrl + '/jsonrpc', baseUrl];
    const json = await mcpRpcTry(endpoints, { 
      jsonrpc: '2.0', 
      id: 3,
      method: 'tools/call', 
      params: { name: toolName, arguments: args } 
    }, headers);
    if (json.error) throw new Error(json.error.message ?? 'MCP tool call failed');
    return json.result;
  }
  
  if (isSseUrl(serverUrl)) {
    const json = await mcpSseRequest(serverUrl, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: toolName, arguments: args } }, headers);
    if (json.error) throw new Error(json.error.message ?? 'MCP tool call failed');
    return json.result;
  }
  const candidates = buildMcpCandidates(serverUrl);
  const json = await mcpRpcTry(candidates, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: toolName, arguments: args } }, headers);
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
  mcp_servers: z.array(z.object({ name: z.string(), url: z.string().url(), headers: z.record(z.string()).optional(), session_id: z.string().optional(), mode: z.enum(['sse', 'http']).default('sse') })).default([]),
  webhook_tools: z.array(z.object({ name: z.string(), base_url: z.string().url(), headers: z.record(z.string()).optional() })).default([]),
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

  // 3. Discover tools (webhook + MCP)
  const allTools: McpTool[] = [];
  
  // A) Simple webhook tools
  console.log('[WEBHOOK] Attempting to discover tools from', parsed.webhook_tools.length, 'webhook servers');
  for (const srv of parsed.webhook_tools) {
    try {
      const res = await fetch(`${srv.base_url}/tools/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...srv.headers },
        body: JSON.stringify({})
      });
      if (res.ok) {
        const data = await res.json();
        const tools = data.tools || [];
        console.log('[WEBHOOK] Discovered', tools.length, 'tools from', srv.name);
        allTools.push(...tools.map((t: any) => ({ ...t, name: `${srv.name}.${t.name}`, source: 'webhook', baseUrl: srv.base_url, headers: srv.headers })));
      }
    } catch (e) {
      console.log('[WEBHOOK] Failed to get tools from', srv.name, ':', e);
    }
  }
  
  // B) MCP tools (if any)
  console.log('[MCP] Attempting to discover tools from', parsed.mcp_servers.length, 'servers');
  for (const srv of parsed.mcp_servers) {
    try {
      const tools = await mcpListTools(srv.url, srv.headers ?? {}, srv.mode);
      console.log(`[MCP-${srv.mode.toUpperCase()}] Discovered`, tools.length, 'tools from', srv.name);
      allTools.push(...tools.map(t => ({ ...t, name: `${srv.name}.${t.name}`, source: 'mcp', mode: srv.mode })));
    } catch (e) {
      console.log(`[MCP-${srv.mode.toUpperCase()}] Failed to get tools from`, srv.name, ':', e);
    }
  }
  console.log('[TOTAL] Tools available:', allTools.length);

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
  const toolNameMap = new Map<string, string>(); // sanitized -> original
  const toolDefs = allTools.slice(0, 64).map(t => {
    const sanitizedName = t.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    toolNameMap.set(sanitizedName, t.name);
    if (sanitizedName !== t.name) {
      console.log(`[SANITIZE] "${t.name}" -> "${sanitizedName}"`);
    }
    return {
      type: 'function' as const,
      function: {
        name: sanitizedName,
        description: t.description ?? 'Tool',
        parameters: t.input_schema ?? { type: 'object', properties: {}, additionalProperties: true }
      }
    };
  });

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
    // 6. Append assistant message with tool_calls before sending tool results
    messages.push(assistantMessage as any);

    // 7. Execute tool calls
    for (const call of toolCalls) {
      const sanitizedName = call.function?.name as string;
      const originalName = toolNameMap.get(sanitizedName) || sanitizedName;
      const [serverName, toolLocal] = originalName.split('.', 2);
      const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      
      // Find tool source
      const tool = allTools.find(t => t.name === originalName);
      let result;
      
      if (tool?.source === 'webhook') {
        // Simple webhook call
        try {
          const res = await fetch(`${tool.baseUrl}/tools/call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tool.headers },
            body: JSON.stringify({ name: toolLocal, arguments: args })
          });
          result = res.ok ? await res.json() : { error: 'Webhook call failed' };
        } catch (e) {
          result = { error: String(e) };
        }
      } else {
        // MCP call (SSE or HTTP)
        const srv = parsed.mcp_servers.find(s => s.name === serverName);
        if (srv) {
          try {
            result = await mcpCallTool(srv.url, toolLocal, args, srv.headers ?? {}, srv.mode);
          } catch (e) {
            result = { error: String(e) };
          }
        }
      }
      
      const toolCallId = (call as any).id || (call as any).tool_call_id;
      const toolContent = typeof result === 'string' ? result : JSON.stringify(result);
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: toolContent } as any);
    }
    // 8. Final response after tools
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


