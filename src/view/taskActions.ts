import { setIcon } from "obsidian";
import { addDays, parseDidaDate, startOfDay } from "../dida/dates.ts";
import { PRIORITIES, PRIORITY_LABEL, type DidaColumn, type DidaTask, type Priority } from "../dida/types.ts";
import { timeToken } from "../dida/quickAdd.ts";
import { describeRepeat, repeatOptions, sameRule } from "../dida/repeat.ts";
import { openDatePicker, sameDay } from "./datePanel.ts";
import { QuickPopover } from "./quickPopover.ts";

export interface TaskActionsHost {
  /** 任务所在项目的分组；项目不分组或还没加载时为空，面板 refresh 时重新取 */
  columns: () => DidaColumn[];
  /** 正文里关联的笔记路径 */
  linkedNote: string | null;
  dispatch: (rect: DOMRect) => void;
  edit: () => void;
  openNote: (path: string) => void;
  /** 给任务建一篇笔记，链接写回正文 */
  createNote: () => void;
  openWeb: () => void;
  /** allDay 不传就只换日子，原来的时刻和时间段都留着 */
  setDate: (d: Date | null, allDay?: boolean) => void;
  setPriority: (p: Priority) => void;
  /** 重复规则，空字符串是不重复 */
  setRepeat: (rule: string) => void;
  moveToColumn: (col: DidaColumn) => void;
  moveToProject: () => void;
  remove: () => void;
  /** 展开这条任务并把光标放进「添加子任务」 */
  addSubtask: () => void;
  /** 同项目里能当父任务的：未完成、本身不是子任务、不是它自己 */
  parentCandidates: () => DidaTask[];
  /** 挂到某条任务下；null 是转成独立任务 */
  setParent: (parentId: string | null) => void;
}

function dueLabel(d: Date, allDay: boolean): string {
  const day = `${d.getMonth() + 1}月${d.getDate()}日`;
  return allDay ? day : `${day} ${timeToken(d.getHours(), d.getMinutes())}`;
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
  /** 当前开着的二级面板（日期、选父任务），同一时间只开一个 */
  let sub: QuickPopover | null = null;
  const closeSub = (): void => sub?.close();
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
      if (open) tile("list-tree", "子任务", () => done(host.addSubtask));
      const note = host.linkedNote;
      if (note) tile("file-text", "笔记", () => done(() => host.openNote(note)));
      else tile("file-plus", "建笔记", () => done(host.createNote));
      tile("external-link", "网页版", () => done(host.openWeb));

      if (open) {
        // 日期
        const today = startOfDay(new Date());
        // 时间段任务按开始时刻算（结束时刻会跟着挪）
        const due = parseDidaDate(task.startDate ?? task.dueDate);
        const monday = addDays(today, ((8 - today.getDay()) % 7) || 7);
        const dateRow = row(body, "日期");
        const dateChip = (label: string, d: Date | null, active: boolean): void => {
          chip(dateRow, label, active, () => done(() => host.setDate(d)));
        };
        dateChip("今天", today, !!due && sameDay(due, today));
        dateChip("明天", addDays(today, 1), !!due && sameDay(due, addDays(today, 1)));
        dateChip("下周一", monday, !!due && sameDay(due, monday));
        const preset = [today, addDays(today, 1), monday];
        const custom = !!due && !preset.some((d) => sameDay(due, d));
        // 其他日子和具体时刻：日期面板作为二级面板开在旁边，操作面板不关
        const other = chip(dateRow, custom && due ? dueLabel(due, task.isAllDay !== false) : "其他…", custom, () => {
          if (sub) return closeSub();
          other.addClass("is-open");
          sub = openDatePicker(doc, other.getBoundingClientRect(), { date: due, allDay: task.isAllDay !== false }, (next) => done(() => host.setDate(next.date, next.allDay)), {
            parent: pop,
            trigger: other,
            onClose: () => {
              sub = null;
              other.removeClass("is-open");
            }
          });
        }, "calendar", "选择其他日期和时间");
        if (due) chip(dateRow, "", false, () => done(() => host.setDate(null)), "x", "清除日期");

        // 重复：常用几档按任务的日子算（没日子按今天，选了会顺便把日子设成今天）
        const repeatRow = row(body, "重复");
        const shortLabel = (label: string): string => label.replace(/^每个工作日$/, "工作日").replace(/^每年.*/, "每年");
        for (const o of repeatOptions(due ?? today)) {
          const on = sameRule(task.repeatFlag, o.rule);
          chip(repeatRow, shortLabel(o.label), on, () => done(() => host.setRepeat(on ? "" : o.rule)), undefined, on ? "取消重复" : o.label);
        }
        const current = describeRepeat(task.repeatFlag);
        if (current && !repeatOptions(due ?? today).some((o) => sameRule(task.repeatFlag, o.rule))) chip(repeatRow, current, true, () => {}, "repeat", "滴答里设的重复规则");
        if (current) chip(repeatRow, "", false, () => done(() => host.setRepeat("")), "x", "取消重复");

        // 优先级：从高到低排，和快速添加的优先级面板一致
        const prioRow = row(body, "优先级");
        for (const pr of [...PRIORITIES].reverse()) {
          chip(prioRow, PRIORITY_LABEL[pr], task.priority === pr, () => done(() => host.setPriority(pr)), "flag", undefined, `is-prio-${pr}`);
        }
      }

      // 分组与项目
      const move = p.section(body);
      const columns = host.columns();
      if (columns.length) {
        move.createDiv({ cls: "dida-pop-title", text: "分组" });
        for (const col of columns) {
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
      if (open && task.parentId) {
        p.item(move, { icon: "corner-left-up", label: "转成独立任务", onSelect: () => done(() => host.setParent(null)) });
      } else if (open && !(task.childIds?.length)) {
        // 面板只按一层缩进显示子任务，所以有子任务的任务不再挂到别处
        const parentRow = p.item(move, {
          icon: "corner-down-right",
          label: "设为子任务…",
          onSelect: () => {
            if (sub) return closeSub();
            const r = parentRow.getBoundingClientRect();
            parentRow.addClass("is-open");
            sub = openParentPicker(task, host.parentCandidates(), doc, r, (id) => done(() => host.setParent(id)), pop, parentRow, () => {
              sub = null;
              parentRow.removeClass("is-open");
            });
          }
        });
      }

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

function chip(parent: HTMLElement, label: string, active: boolean, run: () => void, icon?: string, aria?: string, cls = ""): HTMLButtonElement {
  const b = parent.createEl("button", { cls: `dida-ta-chip ${cls}`.trim(), attr: { type: "button" } });
  if (aria) b.setAttribute("aria-label", aria);
  b.toggleClass("is-active", active);
  if (icon) setIcon(b.createSpan({ cls: "dida-ta-chip-icon" }), icon);
  if (label) b.createSpan({ text: label });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

/** 选父任务：搜索框 + 同项目任务列表，回车或点击即挂上。 */
function openParentPicker(
  task: DidaTask,
  candidates: DidaTask[],
  doc: Document,
  rect: DOMRect,
  onPick: (id: string) => void,
  parent: QuickPopover,
  trigger: HTMLElement,
  onClose: () => void
): QuickPopover {
  const pop: QuickPopover = new QuickPopover(doc, rect, {
    parent,
    cls: "is-parent-picker",
    search: "搜索要挂到哪条任务下",
    render: (p, body, query) => {
      const q = query.toLowerCase();
      const hits = candidates.filter((t) => !q || t.title.toLowerCase().includes(q)).slice(0, 80);
      const sec = p.section(body, `「${task.title}」挂到`);
      sec.addClass("is-scroll");
      for (const t of hits) {
        p.item(sec, {
          icon: "circle",
          label: t.title || "（无标题）",
          onSelect: () => {
            pop.close();
            onPick(t.id);
          }
        });
      }
      if (!hits.length) sec.createDiv({ cls: "dida-pop-empty", text: candidates.length ? "没有匹配的任务" : "这个项目里没有别的任务可挂" });
    },
    onClose,
    trigger
  });
  return pop;
}
