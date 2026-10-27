import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn as nodeSpawn } from "child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

/**
 * 在 Obsidian（Electron 渲染进程）里拉起本机 Claude Code 的胶水。
 * 从 MakerPilot 的 core/process/env.ts 与 providers/claude/runtime/customSpawn.ts 精简移植：
 * GUI 应用的 PATH 很短，要把常见安装位置补进去；SDK 可能用 node 去跑脚本版 CLI；
 * AbortSignal 不能直接传给 spawn（跨 realm 的 instanceof 会失败），手动接管。
 */
const isWindows = process.platform === "win32";
const PATH_SEPARATOR = isWindows ? ";" : ":";
const NODE_EXECUTABLE = isWindows ? "node.exe" : "node";

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isRunnableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** nvm 的默认版本 bin 目录：读 ~/.nvm/alias/default，再到 versions/node 里找匹配的。 */
function nvmDefaultBin(home: string): string | null {
  try {
    const versionsDir = path.join(home, ".nvm", "versions", "node");
    const versions = fs.readdirSync(versionsDir).filter((v) => v.startsWith("v")).sort(compareVersionDesc);
    if (!versions.length) return null;
    let alias = "";
    try {
      alias = fs.readFileSync(path.join(home, ".nvm", "alias", "default"), "utf8").trim();
    } catch {
      alias = "";
    }
    const wanted = alias && !["node", "stable", "default", "lts/*"].includes(alias) ? (alias.startsWith("v") ? alias : `v${alias}`) : null;
    const match = wanted ? versions.find((v) => v === wanted || v.startsWith(`${wanted}.`)) ?? versions[0] : versions[0];
    return path.join(versionsDir, match, "bin");
  } catch {
    return null;
  }
}

function extraBinDirs(): string[] {
  const home = os.homedir();
  const env = process.env;
  if (isWindows) {
    return [
      env.APPDATA ? path.join(env.APPDATA, "npm") : "",
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "nodejs") : "",
      path.join(env.ProgramFiles || "C:\\Program Files", "nodejs"),
      env.NVM_SYMLINK ?? "",
      path.join(home, ".local", "bin"),
      path.join(home, "bin")
    ].filter(Boolean);
  }
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/opt/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "pnpm"),
    env.NVM_BIN ?? nvmDefaultBin(home) ?? ""
  ].filter(Boolean);
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "")
    .split(PATH_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 当前 PATH 前面补上常见安装位置；给了 CLI 路径就把它所在目录也放进去。 */
export function enhancedPath(cliPath?: string | null): string {
  const segments: string[] = [];
  if (cliPath) segments.push(path.dirname(cliPath));
  segments.push(...extraBinDirs(), ...splitPath(process.env.PATH));
  const seen = new Set<string>();
  return segments
    .filter((p) => {
      const key = isWindows ? p.toLowerCase() : p;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(PATH_SEPARATOR);
}

export function findNodeExecutable(pathValue: string): string | null {
  for (const dir of splitPath(pathValue)) {
    const candidate = path.join(dir, NODE_EXECUTABLE);
    if (isRunnableFile(candidate)) return candidate;
  }
  return null;
}

/** 脚本版 CLI（.js / .mjs 或 shebang 里有 node）要用 node 来跑。 */
export function cliRequiresNode(cliPath: string): boolean {
  const lower = cliPath.toLowerCase();
  if ([".js", ".mjs", ".cjs"].some((ext) => lower.endsWith(ext))) return true;
  try {
    const fd = fs.openSync(cliPath, "r");
    try {
      const buffer = Buffer.alloc(200);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytes).toString("utf8");
      return header.startsWith("#!") && header.split(/\r?\n/)[0].toLowerCase().includes("node");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 找本机 claude：设置里填的优先，否则沿增强后的 PATH 找。 */
export function findClaudeExecutable(configured?: string | null): string | null {
  const explicit = configured?.trim() ? expandHome(configured.trim()) : "";
  if (explicit) return isRunnableFile(explicit) ? explicit : null;
  const names = isWindows ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of splitPath(enhancedPath())) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 交给 SDK 的 spawn：补 PATH、把脚本版 CLI 路由到 node、手动处理 abort。 */
export function createSpawn(pathValue: string): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command, args } = options;
    const { cwd, env, signal } = options;
    const requiresNode = command === "node" || cliRequiresNode(command);
    if (requiresNode) {
      const node = findNodeExecutable(pathValue);
      if (command === "node") {
        if (node) command = node;
      } else {
        args = [command, ...args];
        command = node ?? "node";
      }
    }
    const child = nodeSpawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true
    });
    if (signal) {
      const kill = (): void => {
        child.kill("SIGTERM");
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
    if (!child.stdin || !child.stdout) throw new Error("无法建立 Claude Code 进程的输入输出");
    return child as unknown as SpawnedProcess;
  };
}
