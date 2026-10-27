/**
 * 卡片正文里的 Obsidian 深链。路径整体 URL 编码（含 / → %2F），
 * 与工作区约定一致：正文用完整相对路径做显示文字，来源只用文件名。
 */
export function obsidianOpenUrl(vault: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}

export function noteLinkMarkdown(vault: string, path: string, display: string = path): string {
  return `[${display}](${obsidianOpenUrl(vault, path)})`;
}

export function noteContentLine(vault: string, path: string): string {
  return `正文：${noteLinkMarkdown(vault, path)}`;
}

export function hasObsidianLink(content: string | null | undefined): boolean {
  return typeof content === "string" && content.includes("obsidian://open?");
}

/** 从任务正文里取出第一个 Obsidian 深链指向的 vault 内相对路径。 */
export function firstLinkedPath(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = /obsidian:\/\/open\?[^)\s]*?file=([^&)\s]+)/.exec(content);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** 正文里所有 Obsidian 深链指向的 vault 内相对路径，按出现顺序去重。 */
export function linkedPaths(content: string | null | undefined): string[] {
  if (!content) return [];
  const out: string[] = [];
  for (const m of content.matchAll(/obsidian:\/\/open\?[^)\s]*?file=([^&)\s]+)/g)) {
    try {
      const p = decodeURIComponent(m[1]);
      if (!out.includes(p)) out.push(p);
    } catch {
      // 编码坏了的链接跳过
    }
  }
  return out;
}

/** 把正文里的「[显示](obsidian://…)」改写成 [[路径|显示名]]，交给 MakerPilot 时它能当上下文读到。 */
export function obsidianLinksToWikilinks(content: string): string {
  return content.replace(/\[([^\]]*)\]\(obsidian:\/\/open\?[^)]*?file=([^&)]+)[^)]*\)/g, (_m, _label: string, encoded: string) => {
    try {
      const path = decodeURIComponent(encoded);
      const name = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
      return `[[${path}|${name}]]`;
    } catch {
      return _m;
    }
  });
}

/**
 * 把当前笔记的深链写进正文：
 * - 已经含同一个链接：原样返回
 * - 正文为空：写成「正文：[path](url)」
 * - 有「正文：待建」占位：替换掉
 * - 其它：末尾追加一行「关联：[文件名](url)」
 */
export function appendNoteLink(content: string | null | undefined, vault: string, path: string): string {
  const url = obsidianOpenUrl(vault, path);
  const current = content ?? "";
  if (current.includes(url)) return current;
  if (!current.trim()) return noteContentLine(vault, path);
  if (/^正文：待建\s*$/m.test(current)) return current.replace(/^正文：待建[^\n]*$/m, noteContentLine(vault, path));
  const name = path.split("/").pop() ?? path;
  return `${current.replace(/\s+$/, "")}\n关联：${noteLinkMarkdown(vault, path, name)}`;
}
