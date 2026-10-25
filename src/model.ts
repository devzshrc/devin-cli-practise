import { setTimeout as delay } from "node:timers/promises";
import type { Message, Model, ToolCall } from "./types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Transport only: the provider never executes our tools.
export function createDeepSeek(options: {
  apiKey: string; model: string; signal?: AbortSignal; fetch?: typeof fetch;
}): Model {
  if (!options.apiKey || !options.model) throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL in .env");
  const request = options.fetch ?? fetch;
  return async (messages, tools) => {
    const body = JSON.stringify({ model: options.model, messages, tools, tool_choice: "auto",
      thinking: { type: "disabled" }, max_tokens: 4096, stream: false });
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeout = AbortSignal.timeout(60_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await request("https://api.deepseek.com/chat/completions", {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` }, body,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await delay(500 * 2 ** attempt, undefined, { signal: options.signal });
        continue;
      }
      if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}. Check your key, balance, model, or rate limit.`);
      const data: unknown = await response.json();
      if (!record(data) || !Array.isArray(data.choices) || !record(data.choices[0])) throw new Error("Invalid DeepSeek response: missing choices");
      const choice = data.choices[0];
      const raw = choice.message;
      if (!record(raw) || raw.role !== "assistant" || (raw.content !== null && typeof raw.content !== "string")) throw new Error("Invalid assistant message");
      const assistant: Extract<Message, { role: "assistant" }> = { role: "assistant", content: raw.content as string | null };
      if (raw.tool_calls !== undefined) {
        if (!Array.isArray(raw.tool_calls) || raw.tool_calls.length > 8) throw new Error("Expected at most 8 tool calls per response");
        const ids = new Set<string>();
        const calls: ToolCall[] = [];
        for (const call of raw.tool_calls) {
          if (!record(call) || typeof call.id !== "string" || !call.id || ids.has(call.id) || call.type !== "function" ||
            !record(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") throw new Error("Invalid or duplicate tool call");
          ids.add(call.id);
          calls.push({ id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } });
        }
        assistant.tool_calls = calls;
      }
      if (typeof choice.finish_reason !== "string") throw new Error("Missing finish_reason");
      const usage = record(data.usage) ? data.usage.total_tokens : 0;
      return { message: assistant, finishReason: choice.finish_reason,
        tokens: typeof usage === "number" && Number.isFinite(usage) && usage >= 0 ? usage : 0 };
    }
    throw new Error("DeepSeek retry limit reached");
  };
}
