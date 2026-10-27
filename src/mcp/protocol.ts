export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface ToolContent {
  type: string;
  text?: string;
}

export interface ToolCallResult {
  content?: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Streamable HTTP 的 POST 响应可能是 SSE 文本，把每个 data: 块解析成 JSON-RPC 消息。 */
export function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (isRecord(item)) messages.push(item as unknown as JsonRpcMessage);
      } else if (isRecord(parsed)) {
        messages.push(parsed as unknown as JsonRpcMessage);
      }
    } catch {
      // 非 JSON 的事件（心跳等）直接跳过
    }
  }
  return messages;
}

export function pickResponse(messages: JsonRpcMessage[], id: number | string): JsonRpcMessage | null {
  return messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined)) ?? null;
}

/**
 * tools/call 的结果：优先 structuredContent，否则把 text 内容拼起来尝试当 JSON 解析。
 * isError 时抛出错误文本。
 */
export function extractToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const r = result as ToolCallResult;
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (r.isError) throw new Error(text || "滴答清单工具调用失败");
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
