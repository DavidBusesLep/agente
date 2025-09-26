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

  constructor(openai: OpenAI) {
    this.openai = openai;
    this.tools = getLangChainTools();
  }

  private getToolByName(name: string) {
    return this.tools.find(t => t.name === name);
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

      if (!tcalls || !tcalls.length) break;

      for (const call of tcalls) {
        const parsed = ToolCallSchema.safeParse(call);
        if (!parsed.success) continue;
        const toolName = parsed.data.function.name;
        const tool = this.getToolByName(toolName);
        if (!tool) {
          state.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Tool not found: ${toolName}` }) });
          continue;
        }
        let args: any = {};
        try { args = parsed.data.function.arguments ? JSON.parse(parsed.data.function.arguments) : {}; } catch {}
        const result = await tool.invoke(args);
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        try { state.contextToolsOut.push({ name: toolName, args, result }); } catch {}
        if (input.trace) state.trace!.push({ round: round + 1, tool_result: { name: toolName, result } });
      }
    }

    const last = state.messages[state.messages.length - 1];
    return { final: last, messages: state.messages, trace: state.trace, context_tools: state.contextToolsOut };
  }
}


