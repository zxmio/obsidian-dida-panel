/**
 * 卡片正文里的 Obsidian 深链。路径整体 URL 编码（含 / → %2F），
 * 与工作区约定一致：正文用完整相对路径做显示文字，来源只用文件名。
 */
export function obsidianOpenUrl(vault: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}

/** 滴答网页版里这条任务的地址 */
export function taskWebUrl(task: { id: string; projectId: string }): string {
  return `https://dida365.com/webapp/#p/${task.projectId}/tasks/${task.id}`;
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

/*
 * 正文里三种笔记链接，各管一件事：
 * - 正文：这条待办自己的工作笔记，一条待办只绑一篇。卡片上的笔记按钮、操作面板的「笔记」打开的就是它。
 * - 来源：这条待办是从哪篇笔记里来的（会议纪要、复盘），也只有一条，换来源就替换。
 * - 关联：其它参考笔记，可以有很多条，往末尾追加。
 */

/** 某种标签行（正文：/ 来源：）里链接指向的路径 */
function labeledPath(content: string | null | undefined, label: string): string | null {
  if (!content) return null;
  const line = new RegExp(`^${label}：.*$`, "m").exec(content);
  return line ? firstLinkedPath(line[0]) : null;
}

/** 待办绑定的笔记：「正文：」那一行的；没有就退回正文里第一条笔记链接（老数据只有「来源：」时也能打开点东西） */
export function boundNotePath(content: string | null | undefined): string | null {
  return labeledPath(content, "正文") ?? firstLinkedPath(content);
}

/** 来源笔记的路径；没有「来源：」行时为空 */
export function sourceNotePath(content: string | null | undefined): string | null {
  return labeledPath(content, "来源");
}

/** 把某种标签行换成新的链接；没有这一行时，正文行放最前面、来源行放最后面 */
function setLabeledLine(content: string | null | undefined, label: "正文" | "来源", line: string): string {
  const current = content ?? "";
  const re = new RegExp(`^${label}：.*$`, "m");
  if (re.test(current)) return current.replace(re, line);
  if (!current.trim()) return line;
  return label === "正文" ? `${line}\n${current.replace(/^\s+/, "")}` : `${current.replace(/\s+$/, "")}\n${line}`;
}

/** 绑定待办自己的笔记：写成第一行「正文：[路径](url)」，已有正文行（含「正文：待建」）就替换 */
export function setBodyNote(content: string | null | undefined, vault: string, path: string): string {
  return setLabeledLine(content, "正文", noteContentLine(vault, path));
}

/** 设来源：「来源：[文件名](url)」，已有来源行就替换 */
export function setSourceNote(content: string | null | undefined, vault: string, path: string): string {
  return setLabeledLine(content, "来源", `来源：${noteLinkMarkdown(vault, path, path.split("/").pop() ?? path)}`);
}

/** 加一条关联笔记：末尾追加「关联：[文件名](url)」，同一篇已经在正文里就不重复加 */
export function appendRelatedNote(content: string | null | undefined, vault: string, path: string): string {
  const current = content ?? "";
  if (current.includes(obsidianOpenUrl(vault, path))) return current;
  const line = `关联：${noteLinkMarkdown(vault, path, path.split("/").pop() ?? path)}`;
  return current.trim() ? `${current.replace(/\s+$/, "")}\n${line}` : line;
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
