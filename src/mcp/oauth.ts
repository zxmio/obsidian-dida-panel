import { requestUrl } from "obsidian";
import * as http from "http";
import { isRecord } from "./protocol.ts";

/**
 * 滴答清单 MCP 的 OAuth：动态注册客户端 → 浏览器授权（PKCE）→ 本机回环地址收 code → 换 token。
 * 发现文档见 https://mcp.dida365.com/.well-known/oauth-authorization-server。
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  scope: string | null;
}

interface ResourceMeta {
  resource: string;
  authorizationServers: string[];
  scopes: string[];
}

interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await requestUrl({ url, method: "GET", throw: false });
  if (res.status >= 400) throw new Error(`请求 ${url} 失败（${res.status}）`);
  return res.json as unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function discover(endpoint: string): Promise<{ resource: ResourceMeta; server: AuthServerMeta }> {
  const origin = new URL(endpoint).origin;
  let resource: ResourceMeta = { resource: `${origin}/`, authorizationServers: [origin], scopes: [] };
  try {
    const raw = await getJson(`${origin}/.well-known/oauth-protected-resource`);
    if (isRecord(raw)) {
      resource = {
        resource: str(raw.resource) ?? resource.resource,
        authorizationServers: strList(raw.authorization_servers).map((s) => s.replace(/\/$/, "")),
        scopes: strList(raw.scopes_supported)
      };
      if (resource.authorizationServers.length === 0) resource.authorizationServers = [origin];
    }
  } catch {
    // 没有资源元数据就按同源授权服务器处理
  }

  const candidates = [origin, ...resource.authorizationServers.filter((s) => s !== origin)];
  let lastError: unknown = null;
  for (const base of candidates) {
    try {
      const raw = await getJson(`${base}/.well-known/oauth-authorization-server`);
      if (!isRecord(raw)) continue;
      const authorizationEndpoint = str(raw.authorization_endpoint);
      const tokenEndpoint = str(raw.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint) continue;
      return {
        resource,
        server: { authorizationEndpoint, tokenEndpoint, registrationEndpoint: str(raw.registration_endpoint) }
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`找不到授权服务器元数据${lastError instanceof Error ? `：${lastError.message}` : ""}`);
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  scope: string
): Promise<{ clientId: string; clientSecret: string | null }> {
  const res = await requestUrl({
    url: registrationEndpoint,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      client_name: "Obsidian 滴答清单任务面板",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope
    }),
    throw: false
  });
  if (res.status >= 400) throw new Error(`注册客户端失败（${res.status}）：${res.text.slice(0, 200)}`);
  const body: unknown = res.json;
  const clientId = isRecord(body) ? str(body.client_id) : null;
  if (!clientId) throw new Error("注册客户端成功但没有拿到 client_id");
  return { clientId, clientSecret: isRecord(body) ? str(body.client_secret) : null };
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

interface Loopback {
  redirectUri: string;
  waitForCode(state: string, timeoutMs: number): Promise<string>;
  close(): void;
}

const PAGE_OK = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录成功</title>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:48px;color:#222">
<h2 style="margin:0 0 8px">滴答清单已授权</h2><p>可以回到 Obsidian 了，这个页面可以关掉。</p></body></html>`;
const PAGE_FAIL = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录失败</title>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:48px;color:#222">
<h2 style="margin:0 0 8px">授权没有完成</h2><p>回到 Obsidian 重新点一次「登录滴答清单」。</p></body></html>`;

function startLoopback(): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let pending: { state: string; resolve: (code: string) => void; reject: (e: Error) => void } | null = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const ok = !!code && !!pending && state === pending.state;
      res.statusCode = ok ? 200 : 400;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(ok ? PAGE_OK : PAGE_FAIL);
      if (!pending) return;
      if (ok && code) pending.resolve(code);
      else pending.reject(new Error(error ?? (state !== pending.state ? "回调 state 不匹配" : "回调里没有 code")));
      pending = null;
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法打开本机回调端口"));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        waitForCode: (state, timeoutMs) =>
          new Promise<string>((res, rej) => {
            const timer = setTimeout(() => {
              pending = null;
              rej(new Error("等待浏览器授权超时"));
            }, timeoutMs);
            pending = {
              state,
              resolve: (code) => {
                clearTimeout(timer);
                res(code);
              },
              reject: (e) => {
                clearTimeout(timer);
                rej(e);
              }
            };
          }),
        close: () => server.close()
      });
    });
  });
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  clientId: string,
  clientSecret: string | null
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (clientSecret) headers.authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  const res = await requestUrl({
    url: tokenEndpoint,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    headers,
    body: formBody(clientSecret ? params : { ...params, client_id: clientId }),
    throw: false
  });
  if (res.status >= 400) throw new Error(`换取令牌失败（${res.status}）：${res.text.slice(0, 200)}`);
  const body: unknown = res.json;
  const accessToken = isRecord(body) ? str(body.access_token) : null;
  if (!accessToken) throw new Error("令牌响应里没有 access_token");
  const expiresIn = isRecord(body) && typeof body.expires_in === "number" ? body.expires_in : null;
  return {
    accessToken,
    refreshToken: isRecord(body) ? str(body.refresh_token) : null,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    scope: isRecord(body) ? str(body.scope) : null
  };
}

export async function loginWithBrowser(
  endpoint: string,
  openUrl: (url: string) => void,
  onStatus: (status: string) => void = () => undefined
): Promise<OAuthTokens> {
  onStatus("读取授权服务器信息…");
  const { resource, server } = await discover(endpoint);
  if (!server.registrationEndpoint) throw new Error("该服务不支持动态注册客户端，无法自动登录");
  const scope = resource.scopes.length ? resource.scopes.join(" ") : "tasks:read tasks:write";

  const loopback = await startLoopback();
  try {
    onStatus("注册客户端…");
    const { clientId, clientSecret } = await registerClient(server.registrationEndpoint, loopback.redirectUri, scope);
    const verifier = randomString(48);
    const challenge = await pkceChallenge(verifier);
    const state = randomString(16);
    const authorizeUrl = new URL(server.authorizationEndpoint);
    authorizeUrl.search = formBody({
      response_type: "code",
      client_id: clientId,
      redirect_uri: loopback.redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: resource.resource
    });

    onStatus("已打开浏览器，等待授权…");
    openUrl(authorizeUrl.toString());
    const code = await loopback.waitForCode(state, 5 * 60 * 1000);

    onStatus("换取令牌…");
    const token = await tokenRequest(
      server.tokenEndpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: loopback.redirectUri,
        code_verifier: verifier,
        resource: resource.resource
      },
      clientId,
      clientSecret
    );
    return { ...token, clientId, clientSecret, tokenEndpoint: server.tokenEndpoint };
  } finally {
    loopback.close();
  }
}

export function tokensExpired(tokens: OAuthTokens): boolean {
  return tokens.expiresAt !== null && Date.now() > tokens.expiresAt - 60_000;
}

/** 有 refresh_token 才能静默续期；服务端没发 refresh_token 时返回 null，由调用方提示重新登录。 */
export async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens | null> {
  if (!tokens.refreshToken) return null;
  const token = await tokenRequest(
    tokens.tokenEndpoint,
    { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    tokens.clientId,
    tokens.clientSecret
  );
  return { ...tokens, ...token, refreshToken: token.refreshToken ?? tokens.refreshToken };
}
