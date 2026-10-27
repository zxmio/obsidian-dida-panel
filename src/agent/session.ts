import type { CanUseTool, Options, PermissionResult, Query, SDKAssistantMessageError, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { allowedToolPatterns, classifyTool, describeToolCall, didaToolName, disallowedTools, toolLabel, DIDA_MCP_NAME, UPDATE_SOFT_LIMIT, type ToolCallDescription } from "./permissions.ts";
import { createSpawn, enhancedPath } from "./process.ts";
import { loadQuery } from "./sdk.ts";

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; label: string }
  | { type: "tool_end"; id: string; ok: boolean; detail?: string }
  | { type: "status"; text: string }
  | { type: "done"; ok: boolean; error?: string; sessionId: string | null };

export interface AgentDeps {
  vaultPath: string;
  claudePath: string | null;
  model: string | null;
  mcpEndpoint: string;
  getToken: () => string | null;
  confirm: (desc: ToolCallDescription) => Promise<boolean>;
  titleOf: (taskId: string) => string | null;
}

function describeAssistantError(code: SDKAssistantMessageError | undefined): string | null {
  switch (code) {
    case "authentication_failed":
      return "Claude Code 未登录。在终端运行 claude 登录后再试。";
    case "rate_limit":
      return "Claude 额度暂时用完了，稍后再试。";
    case "billing_error":
    case "account_on_hold":
      return "Claude 账号状态异常，去 claude.ai 看看。";
    case "overloaded":
    case "server_error":
      return "Claude 服务繁忙，稍后再试。";
    case "max_output_tokens":
      return "回复太长被截断了，换个更小的要求。";
    case undefined:
      return null;
    default:
      return `Claude 返回错误：${code}`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200);
  if (Array.isArray(content)) {
    return content
      .map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
      .join(" ")
      .slice(0, 200);
  }
  return "";
}

/** 一个对话框对应一个会话：同一 session 连续多轮，resume 续接。 */
export class AgentSession {
  sessionId: string | null = null;
  private query: Query | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly deps: AgentDeps) {}

  get running(): boolean {
    return this.query !== null;
  }

  reset(): void {
    this.stop();
    this.sessionId = null;
  }

  stop(): void {
    this.abort?.abort();
    void this.query?.interrupt?.().catch(() => null);
  }

  async send(text: string, systemPrompt: string, emit: (event: ChatEvent) => void): Promise<void> {
    if (this.query) {
      emit({ type: "done", ok: false, error: "上一轮还在进行，先等它结束或点停止。", sessionId: this.sessionId });
      return;
    }
    const token = this.deps.getToken();
    if (!token) {
      emit({ type: "done", ok: false, error: "尚未登录滴答清单，先在设置里登录。", sessionId: this.sessionId });
      return;
    }

    let queryFn: Awaited<ReturnType<typeof loadQuery>>;
    try {
      queryFn = await loadQuery();
    } catch (error) {
      emit({ type: "done", ok: false, error: `加载 Claude Agent SDK 失败：${error instanceof Error ? error.message : String(error)}`, sessionId: this.sessionId });
      return;
    }

    const pathValue = enhancedPath(this.deps.claudePath);
    let updates = 0;
    const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
      let decision = classifyTool(toolName);
      if (decision === "allow" && didaToolName(toolName) === "update_task") {
        updates += 1;
        if (updates > UPDATE_SOFT_LIMIT) decision = "confirm";
      }
      if (decision === "allow") return { behavior: "allow", updatedInput: input };
      if (decision === "deny") return { behavior: "deny", message: "这个对话框只管滴答清单，不能动文件或执行命令。" };
      const ok = await this.deps.confirm(describeToolCall(toolName, input, this.deps.titleOf));
      return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "用户拒绝了这个操作，请不要再尝试，告诉用户已取消。" };
    };

    const abort = new AbortController();
    this.abort = abort;
    const options: Options = {
      cwd: this.deps.vaultPath,
      env: { ...process.env, PATH: pathValue },
      spawnClaudeCodeProcess: createSpawn(pathValue),
      systemPrompt,
      mcpServers: {
        [DIDA_MCP_NAME]: { type: "http", url: this.deps.mcpEndpoint, headers: { Authorization: `Bearer ${token}` }, timeout: 60_000 }
      },
      allowedTools: allowedToolPatterns(),
      disallowedTools: disallowedTools(),
      canUseTool,
      permissionMode: "default",
      settingSources: [],
      includePartialMessages: true,
      maxTurns: 40,
      abortController: abort
    };
    if (this.deps.claudePath) options.pathToClaudeCodeExecutable = this.deps.claudePath;
    if (this.deps.model) options.model = this.deps.model;
    if (this.sessionId) options.resume = this.sessionId;

    const streamedMessageIds = new Set<string>();
    let currentStreamId: string | null = null;
    let finished = false;
    let lastError: string | null = null;

    try {
      const q = queryFn({ prompt: text, options });
      this.query = q;
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (abort.signal.aborted) break;
        this.handleMessage(msg, emit, {
          onStreamStart: (id) => {
            currentStreamId = id;
            streamedMessageIds.add(id);
          },
          wasStreamed: (id) => streamedMessageIds.has(id) || id === currentStreamId,
          onError: (message) => (lastError = message),
          onResult: (ok, error, sessionId) => {
            finished = true;
            this.sessionId = sessionId ?? this.sessionId;
            emit({ type: "done", ok, error: ok ? undefined : (error ?? lastError ?? "这一轮没有正常结束"), sessionId: this.sessionId });
          }
        });
      }
      if (!finished) {
        emit({ type: "done", ok: false, error: abort.signal.aborted ? "已停止" : (lastError ?? "Claude Code 提前结束了会话"), sessionId: this.sessionId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "done", ok: false, error: abort.signal.aborted ? "已停止" : message, sessionId: this.sessionId });
    } finally {
      this.query = null;
      this.abort = null;
    }
  }

  private handleMessage(
    msg: SDKMessage,
    emit: (event: ChatEvent) => void,
    hooks: {
      onStreamStart: (id: string) => void;
      wasStreamed: (id: string) => boolean;
      onError: (message: string) => void;
      onResult: (ok: boolean, error: string | null, sessionId: string | null) => void;
    }
  ): void {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id;
          const dida = msg.mcp_servers.find((s) => s.name === DIDA_MCP_NAME);
          if (dida && dida.status !== "connected") emit({ type: "status", text: `滴答 MCP 状态：${dida.status}` });
        }
        return;
      }
      case "stream_event": {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === "message_start") hooks.onStreamStart(ev.message.id);
        else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") emit({ type: "text", text: ev.delta.text });
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) return;
        const errorText = describeAssistantError(msg.error);
        if (errorText) hooks.onError(errorText);
        const streamed = hooks.wasStreamed(msg.message.id);
        for (const block of msg.message.content) {
          if (block.type === "text" && !streamed) emit({ type: "text", text: block.text });
          else if (block.type === "tool_use") {
            emit({ type: "tool_start", id: block.id, label: toolLabel(block.name, isRecord(block.input) ? block.input : {}) });
          }
        }
        return;
      }
      case "user": {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
            emit({ type: "tool_end", id: block.tool_use_id, ok: block.is_error !== true, detail: summarizeToolResult(block.content) });
          }
        }
        return;
      }
      case "result": {
        const ok = msg.subtype === "success";
        let error: string | null = null;
        if (!ok) {
          const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === "string") : [];
          error = errors[0] ?? (msg.subtype === "error_max_turns" ? "这一轮步骤太多，被截断了。" : `会话异常结束：${msg.subtype}`);
        }
        hooks.onResult(ok, error, msg.session_id);
        return;
      }
      default:
        return;
    }
  }
}
