import { Notice, type MarkdownPostProcessorContext } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { describeDue } from "../dida/dates.ts";
import type { DidaTask } from "../dida/types.ts";

/**
 * 笔记里内嵌任务块：
 *
 * ```dida
 * project: 内容创作
 * column: 写作中
 * ```
 *
 * 也接受 `project=xxx column=yyy` 写在一行。没有 column 就显示整个项目。
 */
export function parseBlockSource(source: string): { project: string | null; column: string | null; tag: string | null } {
  const out: { project: string | null; column: string | null; tag: string | null } = { project: null, column: null, tag: null };
  for (const m of source.matchAll(/(project|column|tag)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s]+)/g)) {
    const value = m[2].replace(/^["']|["']$/g, "").trim();
    if (m[1] === "project") out.project = value;
    else if (m[1] === "column") out.column = value;
    else out.tag = value;
  }
  return out;
}

function stripDecor(name: string): string {
  return name.replace(/[\p{Extended_Pictographic}️\s]/gu, "").toLowerCase();
}

export function matchName(candidate: string, query: string): boolean {
  const a = stripDecor(candidate);
  const b = stripDecor(query);
  return !!b && (a === b || a.includes(b));
}

export async function renderDidaBlock(
  plugin: DidaPanelPlugin,
  source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext
): Promise<void> {
  const spec = parseBlockSource(source);
  el.addClass("dida-block");
  const header = el.createDiv({ cls: "dida-block-header" });
  const list = el.createDiv({ cls: "dida-block-list" });
  header.createSpan({ cls: "dida-logo", attr: { "aria-hidden": "true" } });
  const label = header.createSpan({ cls: "dida-block-title", text: "滴答清单" });
  const count = header.createSpan({ cls: "dida-block-count" });
  const open = header.createEl("a", { cls: "dida-block-open", text: "在面板中打开", href: "#" });

  if (!spec.project) {
    list.createDiv({ cls: "dida-empty", text: "写法：project: 项目名，可选 column: 列名、tag: 标签" });
    return;
  }

  try {
    const projects = await plugin.store.loadProjects();
    const project = projects.find((p) => matchName(p.name, spec.project ?? ""));
    if (!project) {
      list.createDiv({ cls: "dida-empty", text: `没有找到项目「${spec.project}」` });
      return;
    }
    const snap = await plugin.store.loadProject(project.id);
    const column = spec.column ? snap.columns.find((c) => matchName(c.name, spec.column ?? "")) : null;
    let tasks: DidaTask[] = snap.tasks;
    if (spec.column) tasks = column ? tasks.filter((t) => t.columnId === column.id) : [];
    if (spec.tag) tasks = tasks.filter((t) => (t.tags ?? []).some((x) => matchName(x, spec.tag ?? "")));
    tasks = [...tasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    label.setText(column ? `${project.name} / ${column.name}` : project.name);
    count.setText(`· ${tasks.length} 项`);
    open.addEventListener("click", (e) => {
      e.preventDefault();
      void plugin.activateView().then((view) => view?.showProject(project.id));
    });

    if (!tasks.length) {
      list.createDiv({ cls: "dida-empty", text: "这里暂时没有待办" });
      return;
    }
    for (const task of tasks) {
      const row = list.createDiv({ cls: "dida-block-row" });
      const check = row.createEl("input", { type: "checkbox", cls: `dida-check prio-${task.priority}`, attr: { "aria-label": `完成：${task.title}` } });
      check.addEventListener("change", async () => {
        if (!check.checked) return;
        try {
          await plugin.store.completeTask(task);
          row.addClass("is-done");
        } catch (error) {
          check.checked = false;
          new Notice(`完成失败：${plugin.describeError(error)}`);
        }
      });
      const title = row.createSpan({ cls: "dida-block-row-title", text: task.title });
      title.addEventListener("click", () => plugin.openEditModal(task));
      const due = describeDue(task);
      if (due.label) row.createSpan({ cls: `dida-due is-${due.state}`, text: due.label });
    }
  } catch (error) {
    list.empty();
    list.createDiv({ cls: "dida-error", text: plugin.describeError(error) });
  }
}
