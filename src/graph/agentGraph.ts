import { z } from 'zod';
import OpenAI from 'openai';
import { getLangChainTools } from '../tools/localTools';

export type AgentMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: any; tool_call_id?: string };

export type AgentState = {
  messages: AgentMessage[];
  trace?: any[];
  toolsEnabled: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  contextToolsOut: Array<{ name: string; args: any; result: any }>;
};

export type AgentRunInput = {
  messages: AgentMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
  toolsEnabled: boolean;
  trace?: boolean;
};

const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string(), arguments: z.string().optional() })
});

export class LangGraphOrchestrator {
  private openai: OpenAI;
  private tools: ReturnType<typeof getLangChainTools>;
  private toolExecutionHistory: Array<{ name: string; success: boolean; round: number }> = [];

  constructor(openai: OpenAI) {
    this.openai = openai;
    this.tools = getLangChainTools();
  }

  private getToolByName(name: string) {
    return this.tools.find(t => t.name === name);
  }

  // Validar si una herramienta debe ejecutarse basado en el historial
  private shouldExecuteTool(toolName: string, round: number): { should: boolean; reason?: string } {
    const recentFailures = this.toolExecutionHistory
      .filter(h => h.name === toolName && !h.success && h.round >= round - 2)
      .length;
    
    if (recentFailures >= 2) {
      return { 
        should: false, 
        reason: `La herramienta ${toolName} falló ${recentFailures} veces recientemente. Considera pedir información adicional al usuario.` 
      };
    }
    
    return { should: true };
  }

  // Analizar resultado de tool para feedback al modelo
  private analyzeToolResult(result: any): { hasData: boolean; isEmpty: boolean; hasError: boolean } {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    const isEmpty = resultStr.includes('"cliente":[]') || resultStr.includes('"error"') || resultStr === '[]';
    const hasError = resultStr.includes('"error"');
    const hasData = !isEmpty && !hasError;
    
    return { hasData, isEmpty, hasError };
  }

  async run(input: AgentRunInput) {
    const state: AgentState = {
      messages: [...input.messages],
      trace: input.trace ? [] : undefined,
      toolsEnabled: input.toolsEnabled,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      contextToolsOut: []
    };

    let consecutiveEmptyResults = 0;
    let consecutiveToolCalls = 0;

    for (let round = 0; round < 16; round++) {
      const resp = await this.openai.chat.completions.create({
        model: state.model,
        messages: state.messages as any,
        temperature: state.temperature,
        max_tokens: state.maxTokens,
        tools: state.toolsEnabled
          ? this.tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.schema } }))
          : undefined,
        tool_choice: state.toolsEnabled ? 'auto' : undefined
      } as any);

      const assistant = resp.choices?.[0]?.message as any;
      if (assistant) state.messages.push(assistant);
      const tcalls = (assistant?.tool_calls || []) as any[];

      if (input.trace) {
        const assistantText = String(assistant?.content || '').trim();
        const fallback = tcalls?.length ? `Solicita ejecutar ${tcalls.map(t => t?.function?.name).filter(Boolean).join(', ')}` : '';
        state.trace!.push({ round: round + 1, assistant_message: assistantText || fallback, tool_calls: tcalls.map(t => ({ name: t?.function?.name, arguments: t?.function?.arguments })) });
      }

      if (!tcalls || !tcalls.length) {
        consecutiveToolCalls = 0;
        break;
      }

      consecutiveToolCalls++;
      
      // Detección de loop improductivo: demasiadas tool calls sin responder al usuario
      // Límite aumentado a 15 para permitir operaciones complejas (ej: 4+ pasajeros con ida y vuelta)
      const maxConsecutiveTools = 15;
      
      if (consecutiveToolCalls >= maxConsecutiveTools) {
        state.messages.push({
          role: 'system' as any,
          content: `⚠️ ALERTA: Has ejecutado ${consecutiveToolCalls} herramientas consecutivas sin responder al usuario. 
Esto sugiere que estás en un loop o que falta información crítica.

ACCIÓN REQUERIDA: DETENTE y responde al usuario con:
1. Lo que has descubierto hasta ahora
2. Qué información específica necesitas para continuar
3. Una pregunta directa y clara

NO ejecutes más herramientas en esta ronda. Responde al usuario ahora.`
        });
        break;
      }

      for (const call of tcalls) {
        const parsed = ToolCallSchema.safeParse(call);
        if (!parsed.success) continue;
        const toolName = parsed.data.function.name;
        
        // Validar si debería ejecutarse esta herramienta
        const validation = this.shouldExecuteTool(toolName, round);
        if (!validation.should) {
          state.messages.push({ 
            role: 'tool', 
            tool_call_id: call.id, 
            content: JSON.stringify({ 
              error: `Ejecución bloqueada: ${validation.reason}`,
              suggestion: 'Pide información adicional al usuario o intenta un enfoque diferente.'
            }) 
          });
          this.toolExecutionHistory.push({ name: toolName, success: false, round: round + 1 });
          continue;
        }
        
        const tool = this.getToolByName(toolName);
        if (!tool) {
          state.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Tool not found: ${toolName}` }) });
          this.toolExecutionHistory.push({ name: toolName, success: false, round: round + 1 });
          continue;
        }
        
        let args: any = {};
        try { args = parsed.data.function.arguments ? JSON.parse(parsed.data.function.arguments) : {}; } catch {}
        
        const result = await tool.invoke(args);
        const analysis = this.analyzeToolResult(result);
        
        // Tracking de resultados vacíos consecutivos
        if (analysis.isEmpty || analysis.hasError) {
          consecutiveEmptyResults++;
        } else if (analysis.hasData) {
          consecutiveEmptyResults = 0;
        }
        
        // Agregar feedback contextual al resultado
        let resultWithFeedback = result;
        if (typeof result === 'object' && !Array.isArray(result)) {
          resultWithFeedback = { ...result };
          if (analysis.isEmpty) {
            resultWithFeedback._feedback = `⚠️ Resultado vacío (${consecutiveEmptyResults} consecutivos). Si esperabas datos, verifica los parámetros o pregunta al usuario.`;
          } else if (analysis.hasError) {
            resultWithFeedback._feedback = `❌ Error detectado (${consecutiveEmptyResults} fallos consecutivos). Analiza el mensaje de error y toma acción apropiada (pedir datos, intentar alternativa).`;
          } else if (analysis.hasData) {
            resultWithFeedback._feedback = '✅ Datos obtenidos correctamente. Continúa con el siguiente paso del flujo.';
          }
        }
        
        // Si hay 3 resultados vacíos consecutivos, alertar al modelo
        if (consecutiveEmptyResults >= 3) {
          if (typeof resultWithFeedback === 'object') {
            resultWithFeedback._alert = '🚨 ATENCIÓN: 3 herramientas consecutivas sin datos. Probablemente te falta información del usuario. DETENTE y pregunta directamente qué necesitas.';
          }
        }
        
        state.messages.push({ 
          role: 'tool', 
          tool_call_id: call.id, 
          content: typeof resultWithFeedback === 'string' ? resultWithFeedback : JSON.stringify(resultWithFeedback) 
        });
        
        this.toolExecutionHistory.push({ name: toolName, success: analysis.hasData, round: round + 1 });
        
        try { state.contextToolsOut.push({ name: toolName, args, result }); } catch {}
        if (input.trace) state.trace!.push({ round: round + 1, tool_result: { name: toolName, result, analysis } });
      }
    }

    const last = state.messages[state.messages.length - 1];
    return { final: last, messages: state.messages, trace: state.trace, context_tools: state.contextToolsOut };
  }
}


