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
  reasoningEffort?: 'low' | 'medium' | 'high';
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

  // Generar resumen de herramientas ejecutadas para inyectar en el contexto
  private generateToolsSummary(tools: Array<{ name: string; args: any; result: any }>): string {
    const summaries: string[] = [];
    
    for (const tool of tools) {
      try {
        if (tool.name === 'get_schedules' && tool.result?.Horarios) {
          const horarios = tool.result.Horarios.slice(0, 20); // Limitar a 20 para no saturar
          const times = horarios.map((h: any) => `${h.HoraSalida || h.horario_salida || 'N/A'}`).filter(Boolean);
          if (times.length > 0) {
            summaries.push(`📅 get_schedules: Horarios REALES disponibles: ${times.join(', ')}`);
          }
        } else if (tool.name === 'get_available_seats' && tool.result?.butacas) {
          const butacas = tool.result.butacas.slice(0, 30);
          const seats = butacas.map((b: any) => b.NumeroDeButaca).filter(Boolean);
          if (seats.length > 0) {
            summaries.push(`💺 get_available_seats: Butacas REALES disponibles: ${seats.join(', ')}`);
          }
        } else if (tool.name === 'get_origin_locations' && tool.result?.Localidades) {
          const locs = tool.result.Localidades.slice(0, 15);
          const locations = locs.map((l: any) => `${l.Nombre}(ID:${l.Id})`).filter(Boolean);
          if (locations.length > 0) {
            summaries.push(`📍 get_origin_locations: Localidades REALES: ${locations.join(', ')}`);
          }
        }
      } catch (e) {
        // Ignorar errores de parsing
      }
    }
    
    return summaries.length > 0 ? summaries.join('\n') : '';
  }

  // Detectar si la respuesta contiene datos críticos que deben verificarse
  private containsCriticalData(content: string): boolean {
    if (!content) return false;
    
    // Patrones de datos críticos
    const patterns = [
      /\b\d{1,2}:\d{2}\b/,  // Horarios (HH:MM)
      /\$\s*\d+/,            // Precios ($xxxx)
      /butaca\s*\d+/i,       // Números de butaca
      /asiento\s*\d+/i,      // Números de asiento
      /\bID[:\s]*\d+/i       // IDs
    ];
    
    return patterns.some(pattern => pattern.test(content));
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
      // Construir parámetros base
      const chatParams: any = {
        model: state.model,
        messages: state.messages as any,
        temperature: state.temperature,
        max_tokens: state.maxTokens,
        tools: state.toolsEnabled
          ? this.tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.schema } }))
          : undefined,
        tool_choice: state.toolsEnabled ? 'auto' : undefined
      };

      // Agregar parámetros específicos para modelos o1/o1-pro (GPT-5)
      // reasoning_effort: Controla cuánto "piensa" el modelo
      // - 'low': Más rápido (~20-30s), menos preciso
      // - 'medium': Balanceado (~40-60s)
      // - 'high': Más lento (~80-120s), más preciso
      if (input.reasoningEffort && (state.model.includes('o1') || state.model.includes('gpt-5'))) {
        chatParams.reasoning_effort = input.reasoningEffort;
      }

      const resp = await this.openai.chat.completions.create(chatParams as any);

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
        
        // Antes de devolver la respuesta final, inyectar recordatorio anti-alucinación
        // con los datos disponibles de las herramientas ejecutadas
        if (state.contextToolsOut.length > 0 && assistant?.content) {
          const toolsSummary = this.generateToolsSummary(state.contextToolsOut);
          if (toolsSummary) {
            // Agregar mensaje de sistema con recordatorio de datos disponibles
            state.messages.push({
              role: 'system',
              content: `🛡️ VERIFICACIÓN ANTI-ALUCINACIÓN:
Antes de enviar tu respuesta, verifica que SOLO menciones datos que están en las herramientas ejecutadas:

${toolsSummary}

⚠️ Si tu respuesta menciona horarios, precios, IDs o butacas QUE NO están en esta lista, CORRÍGELA AHORA.
Si no estás seguro, es mejor NO mencionar el dato.`
            } as any);
            
            // Hacer una llamada adicional al LLM para que revise su respuesta
            // (solo si la respuesta contiene datos numéricos o de horarios)
            if (this.containsCriticalData(assistant.content)) {
              const verificationResp = await this.openai.chat.completions.create({
                model: state.model,
                messages: state.messages as any,
                temperature: state.temperature,
                max_tokens: state.maxTokens
              } as any);
              
              const verifiedAssistant = verificationResp.choices?.[0]?.message;
              if (verifiedAssistant) {
                // Reemplazar la respuesta original con la verificada
                const lastAssistantIdx = state.messages.length - 2; // -1 es el system, -2 es el assistant
                state.messages[lastAssistantIdx] = verifiedAssistant as any;
                return { final: verifiedAssistant, messages: state.messages, trace: state.trace, context_tools: state.contextToolsOut };
              }
            }
          }
        }
        
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


