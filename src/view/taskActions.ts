import { setIcon } from "obsidian";
import { addDays, parseDidaDate, startOfDay } from "../dida/dates.ts";
import { PRIORITIES, PRIORITY_LABEL, type DidaColumn, type DidaTask, type Priority } from "../dida/types.ts";
import { QuickPopover } from "./quickPopover.ts";

export interface TaskActionsHost {
  /** 任务所在项目的分组；项目不分组时为空 */
  columns: DidaColumn[];
  /** 正文里关联的笔记路径 */
  linkedNote: string | null;
  dispatch: (rect: DOMRect) => void;
  edit: () => void;
  openNote: (path: string) => void;
  openWeb: () => void;
  setDate: (d: Date | null) => void;
  setPriority: (p: Priority) => void;
  moveToColumn: (col: DidaColumn) => void;
  moveToProject: () => void;
  remove: () => void;
}

function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/**
 * 任务行「更多」的操作面板，代替原生菜单：
 * 顶部一排常用动作 → 日期、优先级两行胶囊 → 分组列表、移到项目 → 删除。
 * 胶囊是一次点完就关；列表行支持上下键和回车。
 */
export function openTaskActions(task: DidaTask, host: TaskActionsHost, doc: Document, rect: DOMRect): QuickPopover {
  const done = (fn: () => void): void => {
    pop.close();
    fn();
  };
  const pop: QuickPopover = new QuickPopover(doc, rect, {
    cls: "is-task-actions",
    render: (p, body) => {
      const open = task.status !== 2;

      // 常用动作
      const quick = body.createDiv({ cls: "dida-ta-quick" });
      const tile = (icon: string, label: string, run: () => void, cls = ""): void => {
        const b = quick.createEl("button", { cls: `dida-ta-tile ${cls}`.trim(), attr: { type: "button" } });
        setIcon(b.createSpan({ cls: "dida-ta-tile-icon" }), icon);
        b.createSpan({ text: label });
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", run);
      };
      if (open) {
        tile("bot", "派给 AI", () => {
          const r = quick.getBoundingClientRect();
          pop.close();
          host.dispatch(r);
        }, "is-accent");
      }
      tile("pencil", "编辑", () => done(host.edit));
      const note = host.linkedNote;
      if (note) tile("file-text", "笔记", () => done(() => host.openNote(note)));
      tile("external-link", "网页版", () => done(host.openWeb));

      if (open) {
        // 日期
        const today = startOfDay(new Date());
        const due = parseDidaDate(task.dueDate ?? task.startDate);
        const monday = addDays(today, ((8 - today.getDay()) % 7) || 7);
        const dateRow = row(body, "日期");
        const dateChip = (label: string, d: Date | null, active: boolean): void => {
          chip(dateRow, label, active, () => done(() => host.setDate(d)));
        };
        dateChip("今天", today, !!due && sameDay(due, today));
        dateChip("明天", addDays(today, 1), !!due && sameDay(due, addDays(today, 1)));
        dateChip("下周一", monday, !!due && sameDay(due, monday));
        if (due) chip(dateRow, "", false, () => done(() => host.setDate(null)), "x", "清除日期");

        // 优先级：从高到低排，和快速添加的优先级面板一致
        const prioRow = row(body, "优先级");
        for (const pr of [...PRIORITIES].reverse()) {
          chip(prioRow, PRIORITY_LABEL[pr], task.priority === pr, () => done(() => host.setPriority(pr)), "flag", undefined, `is-prio-${pr}`);
        }
      }

      // 分组与项目
      const move = p.section(body);
      if (host.columns.length) {
        move.createDiv({ cls: "dida-pop-title", text: "分组" });
        for (const col of host.columns) {
          const current = col.id === task.columnId;
          p.item(move, {
            icon: "kanban",
            label: col.name,
            checked: current,
            onSelect: () => (current ? pop.close() : done(() => host.moveToColumn(col)))
          });
        }
      }
      p.item(move, { icon: "folder-input", label: "移到其他项目…", onSelect: () => done(host.moveToProject) });

      const danger = p.section(body);
      p.item(danger, { icon: "trash-2", label: "删除", cls: "is-danger", onSelect: () => done(host.remove) });
    },
    onClose: () => {}
  });
  return pop;
}

function row(parent: HTMLElement, label: string): HTMLElement {
  const r = parent.createDiv({ cls: "dida-ta-row" });
  r.createSpan({ cls: "dida-ta-row-label", text: label });
  return r.createDiv({ cls: "dida-ta-chips" });
}

function chip(parent: HTMLElement, label: string, active: boolean, run: () => void, icon?: string, aria?: string, cls = ""): void {
  const b = parent.createEl("button", { cls: `dida-ta-chip ${cls}`.trim(), attr: { type: "button" } });
  if (aria) b.setAttribute("aria-label", aria);
  b.toggleClass("is-active", active);
  if (icon) setIcon(b.createSpan({ cls: "dida-ta-chip-icon" }), icon);
  if (label) b.createSpan({ text: label });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
}
