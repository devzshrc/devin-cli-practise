export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
      additionalProperties: false;
    };
  };
};

export type ModelResponse = {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: string;
  tokens: number;
};
export type Model = (messages: Message[], tools: ToolDefinition[]) => Promise<ModelResponse>;
export type ToolRunner = (name: string, input: unknown) => Promise<string>;
export type Event = { type: string; [key: string]: unknown };
export type Logger = (event: Event) => Promise<void>;

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
