import type { query as queryFn } from "@anthropic-ai/claude-agent-sdk";

let modulePromise: Promise<typeof queryFn> | null = null;

/** SDK 的 core 入口体积不小，第一次用到对话框时再加载。 */
export function loadQuery(): Promise<typeof queryFn> {
  modulePromise ??= import("@anthropic-ai/claude-agent-sdk/core").then((m) => m.query);
  return modulePromise;
}
