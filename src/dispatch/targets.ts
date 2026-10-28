/**
 * 派给 AI 的去处。除了 MakerPilot（同 vault 的插件，直接填输入框），
 * 其余都靠桌面 App 注册的链接：新开一个会话，把指令填好，不自动发送。
 *   Claude Code：claude://code/new?q=指令&folder=目录
 *   Claude 对话：claude://claude.ai/new?q=指令
 *   Codex：      codex://threads/new?prompt=指令&path=目录（ChatGPT 桌面 App 注册）
 * 参数名对照各 App 安装包里的链接处理代码（Claude 3.6556、ChatGPT 26.1021）。
 */
import { CLAUDE_LOGO, MAKERPILOT_LOGO, OPENAI_LOGO, type LogoSvg } from "./logos.ts";

export type DispatchTarget = "makerpilot" | "claude-code" | "claude-chat" | "codex";

export interface DispatchTargetInfo {
  id: DispatchTarget;
  label: string;
  /** Obsidian 图标名，用在原生菜单里 */
  icon: string;
  /** 品牌 logo，用在派送面板里 */
  logo: LogoSvg;
  /** macOS 上用来判断装没装的 App 名 */
  app: string | null;
}

export const DISPATCH_TARGETS: DispatchTargetInfo[] = [
  { id: "makerpilot", label: "MakerPilot", icon: "bot", logo: MAKERPILOT_LOGO, app: null },
  { id: "claude-code", label: "Claude Code", icon: "terminal", logo: CLAUDE_LOGO, app: "Claude.app" },
  { id: "claude-chat", label: "Claude 对话", icon: "message-circle", logo: CLAUDE_LOGO, app: "Claude.app" },
  { id: "codex", label: "Codex", icon: "code", logo: OPENAI_LOGO, app: "ChatGPT.app" }
];

/** Claude 桌面 App 对 q 参数的截断长度 */
export const CLAUDE_PROMPT_LIMIT = 14336;

export function targetInfo(id: DispatchTarget): DispatchTargetInfo {
  return DISPATCH_TARGETS.find((t) => t.id === id) ?? DISPATCH_TARGETS[0];
}

export function isDispatchTarget(value: unknown): value is DispatchTarget {
  return DISPATCH_TARGETS.some((t) => t.id === value);
}

function clip(prompt: string, limit: number): string {
  if (prompt.length <= limit) return prompt;
  const note = "\n\n（指令太长，后面截掉了，请到滴答里看完整备注）";
  return prompt.slice(0, limit - note.length) + note;
}

/**
 * 生成打开 App 的链接；MakerPilot 不走链接，返回 null。
 * Claude 会对 q 再解码一次，单独的 % 会让整条链接被拒，换成全角。
 */
export function dispatchUrl(target: DispatchTarget, prompt: string, workdir: string): string | null {
  const params = new URLSearchParams();
  switch (target) {
    case "claude-code":
      params.set("q", clip(prompt.replace(/%/g, "％"), CLAUDE_PROMPT_LIMIT));
      if (workdir) params.set("folder", workdir);
      return `claude://code/new?${params}`;
    case "claude-chat":
      params.set("q", clip(prompt.replace(/%/g, "％"), CLAUDE_PROMPT_LIMIT));
      return `claude://claude.ai/new?${params}`;
    case "codex":
      params.set("prompt", prompt);
      if (workdir) params.set("path", workdir);
      return `codex://threads/new?${params}`;
    default:
      return null;
  }
}
