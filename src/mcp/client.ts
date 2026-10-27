import { requestUrl } from "obsidian";
import { extractToolResult, parseSseMessages, pickResponse, isRecord, type JsonRpcMessage } from "./protocol.ts";

export class McpAuthError extends Error {
  constructor(message = "尚未登录滴答清单，或登录已失效") {
    super(message);
    this.name = "McpAuthError";
  }
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

class McpSessionExpired extends Error {}

export interface McpClientOptions {
  endpoint: () => string;
  getToken: () => string | null;
  clientInfo: { name: string; version: string };
}

const PROTOCOL_VERSION = "2025-06-18";

function header(headers: Record<string, string>, name: string): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/** 面向滴答清单 MCP 服务的 Streamable HTTP 客户端：initialize 一次，之后只发 tools/call。 */
export class McpClient {
  private sessionId: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;

  constructor(private readonly opts: McpClientOptions) {}

  reset(): void {
    this.sessionId = null;
    this.initialized = false;
    this.initPromise = null;
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    return extractToolResult(result) as T;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    this.sessionId = null;
    await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.opts.clientInfo
      }
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    this.initialized = true;
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    await this.ensureInitialized();
    const message: JsonRpcMessage = { jsonrpc: "2.0", id: this.nextId++, method, params };
    try {
      return await this.post(message);
    } catch (error) {
      if (error instanceof McpSessionExpired) {
        this.reset();
        await this.ensureInitialized();
        return await this.post({ ...message, id: this.nextId++ });
      }
      throw error;
    }
  }

  private async post(message: JsonRpcMessage, expectResponse = true): Promise<unknown> {
    const token = this.opts.getToken();
    if (!token) throw new McpAuthError();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": PROTOCOL_VERSION
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await requestUrl({
      url: this.opts.endpoint(),
      method: "POST",
      headers,
      body: JSON.stringify(message),
      throw: false
    });

    if (res.status === 401 || res.status === 403) {
      this.reset();
      throw new McpAuthError();
    }
    if (res.status === 404 && this.sessionId) throw new McpSessionExpired();
    if (res.status >= 400) throw new McpError(`滴答清单服务返回 ${res.status}：${res.text.slice(0, 200)}`);

    const sid = header(res.headers, "mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!expectResponse || message.id === undefined) return null;

    const contentType = header(res.headers, "content-type") ?? "";
    let reply: JsonRpcMessage | null = null;
    if (contentType.includes("text/event-stream")) {
      reply = pickResponse(parseSseMessages(res.text), message.id);
    } else {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        parsed = null;
      }
      if (Array.isArray(parsed)) {
        reply = pickResponse(parsed as JsonRpcMessage[], message.id);
      } else if (isRecord(parsed)) {
        reply = parsed as unknown as JsonRpcMessage;
      }
    }
    if (!reply) throw new McpError("滴答清单服务没有返回可识别的响应");
    if (reply.error) throw new McpError(reply.error.message || `错误码 ${reply.error.code}`);
    return reply.result;
  }
}
