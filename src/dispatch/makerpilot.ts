import type { App } from "obsidian";

/**
 * MakerPilot 没有公开 API，但它的插件实例在同一个 vault 里能拿到，
 * 这里只用它自己文件菜单也在用的三个方法：激活视图、新建会话、往输入框追加文本。
 * 签名对照 ~/Dev/MakerPilot/src/composition/ClaudianViews.ts 与 features/chat/ClaudianView.ts。
 */
interface MakerPilotView {
  startNewConversation?: () => Promise<void>;
  appendToActiveInput?: (text: string) => boolean;
  focusActiveInput?: () => void;
}

interface MakerPilotPlugin {
  views?: {
    activateView: () => Promise<void>;
    getView: () => MakerPilotView | null;
  };
}

interface PluginRegistry {
  plugins?: { plugins?: Record<string, unknown> };
}

export type DispatchResult = "sent" | "no-plugin" | "not-ready";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function findMakerPilot(app: App): MakerPilotPlugin | null {
  const registry = app as unknown as PluginRegistry;
  const plugin = registry.plugins?.plugins?.makerpilot;
  if (!plugin || typeof plugin !== "object") return null;
  const candidate = plugin as MakerPilotPlugin;
  return typeof candidate.views?.activateView === "function" && typeof candidate.views.getView === "function" ? candidate : null;
}

/** 打开 MakerPilot，按需新建会话，把指令填进输入框（不自动发送）。 */
export async function sendToMakerPilot(app: App, prompt: string, newConversation: boolean): Promise<DispatchResult> {
  const plugin = findMakerPilot(app);
  if (!plugin?.views) return "no-plugin";
  await plugin.views.activateView();
  let view = plugin.views.getView();
  if (!view) {
    await sleep(300);
    view = plugin.views.getView();
  }
  if (!view) return "not-ready";
  if (newConversation && typeof view.startNewConversation === "function") {
    await view.startNewConversation();
  }
  for (const wait of [120, 400, 900]) {
    await sleep(wait);
    if (view.appendToActiveInput?.(prompt)) {
      view.focusActiveInput?.();
      return "sent";
    }
  }
  return "not-ready";
}
