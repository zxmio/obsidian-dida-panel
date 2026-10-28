import { describeDue } from "../dida/dates.ts";
import { linkedPaths, obsidianLinksToWikilinks } from "../dida/deeplink.ts";
import { PRIORITY_LABEL, taskBody, type DidaTask } from "../dida/types.ts";

/**
 * 派活指令模板。占位符：
 *   {{title}} {{project}} {{column}} {{tags}} {{due}} {{priority}} {{notes}} {{links}}
 * 空的占位符整行会被收掉，所以模板里一行放一个占位符最稳。
 */
export const DEFAULT_DISPATCH_TEMPLATE = `请处理这条滴答清单待办。完成后把结果写进相关笔记（没有就按工作区约定新建一篇），再告诉我可以把它标记完成。

待办：{{title}}
所在：{{project}}{{column}}
截止：{{due}}
优先级：{{priority}}
标签：{{tags}}
备注：
{{notes}}

相关笔记：{{links}}`;

export interface DispatchContext {
  projectName: string;
  columnName: string | null;
  tagLabels: string[];
  /** 队列标签本身不写进指令 */
  queueTag: string;
  vaultName: string;
  template?: string;
  now?: Date;
}

function wikilink(path: string): string {
  const name = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  return `[[${path}|${name}]]`;
}

export function buildDispatchPrompt(task: DidaTask, ctx: DispatchContext): string {
  const template = ctx.template?.trim() ? ctx.template : DEFAULT_DISPATCH_TEMPLATE;
  const due = describeDue(task, ctx.now);
  const tags = ctx.tagLabels.filter((t) => t !== ctx.queueTag);
  const paths = linkedPaths(taskBody(task));
  const notes = taskBody(task).trim();

  const values: Record<string, string> = {
    title: task.title.trim(),
    project: ctx.projectName,
    column: ctx.columnName ? ` / ${ctx.columnName}` : "",
    tags: tags.join("、"),
    due: due.label,
    priority: task.priority ? PRIORITY_LABEL[task.priority] : "",
    notes: notes ? obsidianLinksToWikilinks(notes) : "",
    links: paths.map(wikilink).join(" ")
  };

  const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => values[key] ?? "");
  return filled
    .split("\n")
    .filter((line) => {
      // 「标签：」「截止：」这类只剩标签没有值的行收掉
      const m = /^([^\n：:]{1,12})[：:]\s*$/.exec(line.trim());
      return !m || line.trim() === "备注：";
    })
    .join("\n")
    .replace(/备注：\n(?=\n|$)/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 标签数组里加上队列标签（已有则原样返回）。 */
export function withQueueTag(tags: string[] | null | undefined, queueTag: string): string[] {
  const list = [...(tags ?? [])];
  return list.includes(queueTag) ? list : [...list, queueTag];
}

export function withoutQueueTag(tags: string[] | null | undefined, queueTag: string): string[] {
  return (tags ?? []).filter((t) => t !== queueTag);
}

export function isQueued(task: DidaTask, queueTag: string): boolean {
  return (task.tags ?? []).includes(queueTag);
}
