import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSpawn, enhancedPath } from "./process.ts";
import { loadQuery } from "./sdk.ts";

export interface OneShotDeps {
  vaultPath: string;
  claudePath: string | null;
  model: string | null;
}

export interface OneShotRequest {
  systemPrompt: string;
  prompt: string;
  /** 结构化输出的 JSON Schema */
  schema: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * 不带任何工具的一次性调用：模型只读给它的数据、按 Schema 回一个 JSON。
 * 返回 structured_output；模型没走结构化输出时退回最后一段文字，由调用方解析。
 */
export async function runStructured(deps: OneShotDeps, req: OneShotRequest): Promise<unknown> {
  const queryFn = await loadQuery();
  const pathValue = enhancedPath(deps.claudePath);
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  req.signal.addEventListener("abort", onAbort);

  const options: Options = {
    cwd: deps.vaultPath,
    env: { ...process.env, PATH: pathValue },
    spawnClaudeCodeProcess: createSpawn(pathValue),
    systemPrompt: req.systemPrompt,
    tools: [],
    mcpServers: {},
    settingSources: [],
    permissionMode: "default",
    canUseTool: async () => ({ behavior: "deny", message: "体检只读给定的数据，不调用工具。" }),
    outputFormat: { type: "json_schema", schema: req.schema },
    maxTurns: 4,
    abortController: abort
  };
  if (deps.claudePath) options.pathToClaudeCodeExecutable = deps.claudePath;
  if (deps.model) options.model = deps.model;

  let lastText = "";
  try {
    for await (const msg of queryFn({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
      if (abort.signal.aborted) break;
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        if (msg.error === "authentication_failed") throw new Error("Claude Code 未登录。在终端运行 claude 登录后再试。");
        if (msg.error === "rate_limit") throw new Error("Claude 额度暂时用完了，稍后再试。");
        const text = msg.message.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        if (text) lastText = text;
      } else if (msg.type === "result") {
        if (msg.subtype === "success") return msg.structured_output ?? msg.result ?? lastText;
        const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === "string") : [];
        throw new Error(errors[0] ?? `体检没有正常结束：${msg.subtype}`);
      }
    }
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
  if (req.signal.aborted) throw new Error("已取消");
  if (lastText) return lastText;
  throw new Error("Claude Code 提前结束了会话");
}
