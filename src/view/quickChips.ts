import { setIcon } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { addDays, startOfDay } from "../dida/dates.ts";
import { dateToken, parseQuickAdd, projectToken, setQuickToken, timeToken, toggleQuickTag, type QuickAddResult } from "../dida/quickAdd.ts";
import { INBOX_ID, PRIORITY_LABEL, type DidaColumn, type DidaProject, type Priority } from "../dida/types.ts";
import { isSeparatorProject } from "../store.ts";
import { QuickPopover } from "./quickPopover.ts";

type ChipKind = "date" | "priority" | "tag" | "project" | "column";

export interface QuickChipsHost {
  plugin: DidaPanelPlugin;
  input: HTMLInputElement;
  defaultProjectId: () => string;
  matchProject: (query: string) => DidaProject | null;
  /** 写回输入框；refocus 为 true 时把光标放回输入框末尾 */
  setValue: (next: string, refocus: boolean) => void;
  /** 目标项目的分组；还没加载过返回 null（会顺手触发加载），不分组的项目返回空数组 */
  columns: (projectId: string) => DidaColumn[] | null;
  /** 选中的分组：undefined 是默认（第一个分组），null 是「未分组」 */
  column: (projectId: string) => string | null | undefined;
  setColumn: (projectId: string, columnId: string | null | undefined) => void;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TIMES: [number, number][] = [[9, 0], [12, 0], [14, 0], [18, 0], [20, 0]];
const PRIORITY_ROWS: { p: Priority; key: string }[] = [
  { p: 5, key: "1" },
  { p: 3, key: "2" },
  { p: 1, key: "3" },
  { p: 0, key: "0" }
];

function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function hint(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

export function quickDateLabel(d: Date, allDay: boolean, now: Date = new Date()): string {
  const day = startOfDay(d);
  const diff = Math.round((day.getTime() - startOfDay(now).getTime()) / 86_400_000);
  let label =
    diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : diff === -1 ? "昨天" : diff > 2 && diff < 7 ? WEEKDAYS[day.getDay()] : `${day.getMonth() + 1}月${day.getDate()}日`;
  if (!allDay) label += ` ${timeToken(d.getHours(), d.getMinutes())}`;
  return label;
}

/**
 * 快速添加框下的四个快捷按钮。输入框里的速记始终是唯一事实源：
 * 按钮显示从速记里解析出的值，弹出面板里的选择也只是改写速记。
 */
export class QuickChips {
  private readonly row: HTMLElement;
  private readonly host: QuickChipsHost;
  private pop: QuickPopover | null = null;
  private openKind: ChipKind | null = null;
  /** 日历当前显示的月份（每月 1 日） */
  private month: Date | null = null;

  constructor(row: HTMLElement, host: QuickChipsHost) {
    this.row = row;
    this.host = host;
  }

  destroy(): void {
    this.pop?.close();
  }

  private get value(): string {
    return this.host.input.value;
  }

  private parsed(): QuickAddResult {
    return parseQuickAdd(this.value);
  }

  render(): void {
    this.row.empty();
    const parsed = this.parsed();
    const today = startOfDay(new Date());

    const dateCls = !parsed.date ? "" : startOfDay(parsed.date) < today ? "is-overdue" : sameDay(parsed.date, today) ? "is-today" : "";
    this.chip("date", "calendar", parsed.date ? quickDateLabel(parsed.date, parsed.allDay) : "日期", !!parsed.date, dateCls, () =>
      this.host.setValue(setQuickToken(setQuickToken(this.value, "date", null), "time", null), true)
    );

    const prio = parsed.priority;
    this.chip("priority", "flag", prio ? PRIORITY_LABEL[prio] : "优先级", !!prio, prio ? `is-prio-${prio}` : "", () =>
      this.host.setValue(setQuickToken(this.value, "priority", null), true)
    );

    const tags = parsed.tags.map((t) => this.host.plugin.tagLabel(t));
    const tagLabel = tags.length ? (tags.length > 2 ? `${tags.slice(0, 2).join("、")} +${tags.length - 2}` : tags.join("、")) : "标签";
    this.chip("tag", "tag", tagLabel, tags.length > 0, "", () => {
      let next = this.value;
      for (const t of parsed.tags) next = toggleQuickTag(next, t);
      this.host.setValue(next, true);
    });

    const target = parsed.projectQuery ? this.host.matchProject(parsed.projectQuery) : null;
    const projectId = parsed.projectQuery ? target?.id ?? null : this.host.defaultProjectId();
    const store = this.host.plugin.store;
    const projectLabel = parsed.projectQuery ? target?.name ?? `没找到「${parsed.projectQuery}」` : store.projectName(projectId);
    this.chip(
      "project",
      projectId === INBOX_ID ? "inbox" : "folder",
      projectLabel,
      !!parsed.projectQuery,
      parsed.projectQuery && !target ? "is-missing" : "",
      () => this.host.setValue(setQuickToken(this.value, "project", null), true)
    );

    // 分组跟着目标项目走：项目有分组才出现，换了项目就回到默认
    const columns = projectId ? this.host.columns(projectId) : null;
    if (projectId && columns?.length) {
      const chosen = this.host.column(projectId);
      const label = chosen === null ? "未分组" : columns.find((c) => c.id === chosen)?.name ?? columns[0].name;
      this.chip("column", "kanban", label, chosen !== undefined, "", () => {
        this.host.setColumn(projectId, undefined);
        this.render();
      });
    }
  }

  /** 快速添加时用的分组：undefined 表示不指定（项目没有分组）。 */
  columnFor(projectId: string): string | undefined {
    const columns = this.host.columns(projectId);
    if (!columns?.length) return undefined;
    const chosen = this.host.column(projectId);
    if (chosen === null) return undefined;
    return columns.find((c) => c.id === chosen)?.id ?? columns[0].id;
  }

  private targetProjectId(): string | null {
    const parsed = this.parsed();
    return parsed.projectQuery ? this.host.matchProject(parsed.projectQuery)?.id ?? null : this.host.defaultProjectId();
  }

  private chip(kind: ChipKind, icon: string, label: string, set: boolean, cls: string, onClear: () => void): void {
    const btn = this.row.createEl("button", { cls: `dida-qchip ${cls}`.trim(), attr: { type: "button", "aria-haspopup": "true" } });
    btn.toggleClass("is-set", set);
    btn.toggleClass("is-open", this.openKind === kind);
    setIcon(btn.createSpan({ cls: "dida-qchip-icon" }), icon);
    btn.createSpan({ cls: "dida-qchip-text", text: label });
    if (set) {
      const clear = btn.createSpan({ cls: "dida-qchip-clear", attr: { "aria-label": "清除" } });
      setIcon(clear, "x");
      clear.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pop?.close();
        onClear();
      });
    }
    // 按下时不让输入框失焦，选完还能接着打字
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const same = this.openKind === kind;
      // 关掉旧面板会重画按钮，先记下位置
      const rect = btn.getBoundingClientRect();
      this.pop?.close();
      if (!same) this.open(kind, rect);
    });
  }

  private open(kind: ChipKind, rect: DOMRect): void {
    const onClose = (byKeyboard: boolean): void => {
      this.pop = null;
      this.openKind = null;
      this.render();
      if (byKeyboard) this.host.setValue(this.value, true);
    };
    this.openKind = kind;
    this.render();
    const doc = this.row.doc;
    if (kind === "date") {
      const d = this.parsed().date;
      this.month = new Date((d ?? new Date()).getFullYear(), (d ?? new Date()).getMonth(), 1);
      this.pop = new QuickPopover(doc, rect, { cls: "is-date", render: (pop, body) => this.renderDate(pop, body), onClose });
    } else if (kind === "priority") {
      this.pop = new QuickPopover(doc, rect, {
        cls: "is-priority",
        render: (pop, body) => this.renderPriority(pop, body),
        onKey: (key) => {
          const row = PRIORITY_ROWS.find((r) => r.key === key);
          if (row) this.pick(setQuickToken(this.value, "priority", row.p ? `!${PRIORITY_LABEL[row.p]}` : null));
          return !!row;
        },
        onClose
      });
    } else if (kind === "tag") {
      this.pop = new QuickPopover(doc, rect, { cls: "is-tag", search: "搜索或新建标签", render: (pop, body, q) => this.renderTags(pop, body, q), onClose });
    } else if (kind === "column") {
      this.pop = new QuickPopover(doc, rect, { cls: "is-column", render: (pop, body) => this.renderColumns(pop, body), onClose });
    } else {
      this.pop = new QuickPopover(doc, rect, { cls: "is-project", search: "搜索项目", render: (pop, body, q) => this.renderProjects(pop, body, q), onClose });
    }
  }

  /** 单选：写回速记、关面板、光标回到输入框。 */
  private pick(next: string): void {
    this.host.setValue(next, false);
    this.pop?.close(true);
  }

  // ---------- 日期 ----------

  private renderDate(pop: QuickPopover, body: HTMLElement): void {
    const parsed = this.parsed();
    const today = startOfDay(new Date());
    const setDate = (d: Date, word?: string): void => this.pick(setQuickToken(this.value, "date", word ?? dateToken(d)));

    const quick = pop.section(body);
    const saturday = addDays(today, (6 - today.getDay() + 7) % 7);
    const monday = addDays(today, ((1 - today.getDay() + 7) % 7) || 7);
    const rows: [string, string, Date, string][] = [
      ["sun", "今天", today, "今天"],
      ["sunrise", "明天", addDays(today, 1), "明天"],
      ["sofa", "本周末", saturday, "周六"],
      ["calendar-days", "下周一", monday, "下周一"]
    ];
    for (const [icon, label, d, word] of rows) {
      pop.item(quick, { icon, label, hint: hint(d), checked: !!parsed.date && sameDay(parsed.date, d), onSelect: () => setDate(d, word) });
    }

    this.renderCalendar(pop, pop.section(body, undefined), parsed.date, today, setDate);

    const timeSec = pop.section(body, "时间");
    const grid = timeSec.createDiv({ cls: "dida-pop-times" });
    const current = parsed.date && !parsed.allDay ? timeToken(parsed.date.getHours(), parsed.date.getMinutes()) : null;
    const timeBtn = (text: string, active: boolean, onClick: () => void): void => {
      const b = grid.createEl("button", { cls: "dida-pop-time", text, attr: { type: "button" } });
      b.toggleClass("is-active", active);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", onClick);
    };
    timeBtn("全天", !current, () => this.pick(setQuickToken(this.value, "time", null)));
    for (const [h, m] of TIMES) {
      const token = timeToken(h, m);
      timeBtn(token, current === token, () => this.pick(setQuickToken(this.value, "time", token)));
    }
    const custom = grid.createEl("input", { cls: "dida-pop-time-input", type: "time", attr: { "aria-label": "自定义时间" } });
    if (current && !TIMES.some(([h, m]) => timeToken(h, m) === current)) {
      custom.value = current;
      custom.addClass("is-active");
    }
    custom.addEventListener("change", () => {
      const [h, m] = custom.value.split(":").map(Number);
      if (Number.isFinite(h) && Number.isFinite(m)) this.pick(setQuickToken(this.value, "time", timeToken(h, m)));
    });

    if (parsed.date) {
      const foot = pop.section(body);
      pop.item(foot, {
        icon: "calendar-x",
        label: "清除日期和时间",
        cls: "is-muted",
        onSelect: () => this.pick(setQuickToken(setQuickToken(this.value, "date", null), "time", null))
      });
    }
  }

  private renderCalendar(pop: QuickPopover, sec: HTMLElement, selected: Date | null, today: Date, setDate: (d: Date) => void): void {
    const month = this.month ?? new Date(today.getFullYear(), today.getMonth(), 1);
    const head = sec.createDiv({ cls: "dida-cal-head" });
    head.createSpan({ cls: "dida-cal-title", text: `${month.getFullYear()}年${month.getMonth() + 1}月` });
    const nav = head.createDiv({ cls: "dida-cal-nav" });
    const navBtn = (icon: string, label: string, delta: number): void => {
      const b = nav.createEl("button", { cls: "dida-cal-btn", attr: { type: "button", "aria-label": label } });
      if (icon) setIcon(b, icon);
      else b.setText(label);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        this.month = delta === 0 ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(month.getFullYear(), month.getMonth() + delta, 1);
        pop.refresh();
      });
    };
    navBtn("chevron-left", "上个月", -1);
    navBtn("", "今", 0);
    navBtn("chevron-right", "下个月", 1);

    const grid = sec.createDiv({ cls: "dida-cal-grid" });
    for (const w of ["一", "二", "三", "四", "五", "六", "日"]) grid.createSpan({ cls: "dida-cal-wd", text: w });
    // 周一开头，补齐上月的尾巴，固定画 6 行免得面板高度跳
    const lead = (month.getDay() + 6) % 7;
    const start = addDays(month, -lead);
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const cell = grid.createEl("button", { cls: "dida-cal-day", text: String(d.getDate()), attr: { type: "button" } });
      cell.toggleClass("is-outside", d.getMonth() !== month.getMonth());
      cell.toggleClass("is-past", d < today);
      cell.toggleClass("is-today", sameDay(d, today));
      cell.toggleClass("is-selected", !!selected && sameDay(d, selected));
      cell.addEventListener("mousedown", (e) => e.preventDefault());
      cell.addEventListener("click", () => setDate(d));
    }
  }

  // ---------- 优先级 ----------

  private renderPriority(pop: QuickPopover, body: HTMLElement): void {
    const current = this.parsed().priority ?? 0;
    const sec = pop.section(body);
    for (const { p, key } of PRIORITY_ROWS) {
      pop.item(sec, {
        icon: "flag",
        label: p ? `${PRIORITY_LABEL[p]}优先级` : "无优先级",
        hint: key,
        checked: current === p,
        cls: `is-prio-${p}`,
        onSelect: () => this.pick(setQuickToken(this.value, "priority", p ? `!${PRIORITY_LABEL[p]}` : null))
      });
    }
  }

  // ---------- 标签 ----------

  private renderTags(pop: QuickPopover, body: HTMLElement, query: string): void {
    const plugin = this.host.plugin;
    const chosen = this.parsed().tags;
    const isChosen = (name: string, label: string): boolean => chosen.includes(name) || chosen.includes(label);
    const aiTag = plugin.settings.aiTag.toLowerCase();
    const q = query.toLowerCase();
    const all = plugin.store.tags.filter((t) => t.name !== aiTag);
    // 不把已选的挪到前面：多选时列表顺序不动，光标下的行不会跳
    const hits = all.filter((t) => !q || t.label.toLowerCase().includes(q) || t.name.includes(q));
    const toggle = (name: string): void => {
      this.host.setValue(toggleQuickTag(this.value, name), false);
      pop.refresh();
    };

    const sec = pop.section(body);
    sec.addClass("is-scroll");
    for (const t of hits.slice(0, 60)) {
      pop.item(sec, { checkbox: true, dot: t.color, label: t.label, checked: isChosen(t.name, t.label), onSelect: () => toggle(t.name) });
    }
    // 输入框里打的新标签不在滴答标签列表里，也要能取消
    for (const name of chosen.filter((n) => !plugin.store.tagByName(n) && (!q || n.toLowerCase().includes(q)))) {
      pop.item(sec, { checkbox: true, dot: null, label: name, hint: "新标签", checked: true, onSelect: () => toggle(name) });
    }
    const fresh = query.replace(/\s+/g, "").replace(/^#/, "");
    if (fresh && !all.some((t) => t.label === fresh || t.name === fresh.toLowerCase()) && !chosen.includes(fresh)) {
      pop.item(sec, {
        icon: "plus",
        label: `新建「${fresh}」`,
        cls: "is-create",
        onSelect: () => {
          pop.clearSearch();
          toggle(fresh);
        }
      });
    }
    if (!sec.childElementCount) sec.createDiv({ cls: "dida-pop-empty", text: all.length ? "没有匹配的标签" : "还没有标签，输入名称新建" });
  }

  // ---------- 分组 ----------

  private renderColumns(pop: QuickPopover, body: HTMLElement): void {
    const projectId = this.targetProjectId();
    const columns = projectId ? this.host.columns(projectId) ?? [] : [];
    if (!projectId) return;
    const chosen = this.host.column(projectId);
    const current = chosen === null ? null : columns.find((c) => c.id === chosen)?.id ?? columns[0]?.id;
    const choose = (id: string | null): void => {
      this.host.setColumn(projectId, id === columns[0]?.id ? undefined : id);
      this.pop?.close(true);
    };
    const sec = pop.section(body);
    sec.addClass("is-scroll");
    columns.forEach((c, i) => {
      pop.item(sec, { icon: "kanban", label: c.name, hint: i === 0 ? "默认" : undefined, checked: current === c.id, onSelect: () => choose(c.id) });
    });
    const foot = pop.section(body);
    pop.item(foot, { icon: "circle-dashed", label: "未分组", checked: current === null, onSelect: () => choose(null) });
  }

  // ---------- 项目 ----------

  private renderProjects(pop: QuickPopover, body: HTMLElement, query: string): void {
    const store = this.host.plugin.store;
    const parsed = this.parsed();
    const fallback = this.host.defaultProjectId();
    const target = parsed.projectQuery ? this.host.matchProject(parsed.projectQuery)?.id ?? null : fallback;
    const q = query.replace(/\s+/g, "").toLowerCase();
    const projects = store.projects.filter((p) => !p.closed && !isSeparatorProject(p.name) && (!q || p.name.replace(/\s+/g, "").toLowerCase().includes(q)));

    const sec = pop.section(body);
    sec.addClass("is-scroll");
    for (const p of projects) {
      const isDefault = p.id === fallback;
      pop.item(sec, {
        icon: p.id === INBOX_ID ? "inbox" : "folder",
        label: p.name,
        hint: isDefault ? "默认" : store.groupName(p.groupId) ?? undefined,
        checked: p.id === target,
        onSelect: () => this.pick(setQuickToken(this.value, "project", isDefault ? null : projectToken(p.name)))
      });
    }
    if (!projects.length) sec.createDiv({ cls: "dida-pop-empty", text: "没有匹配的项目" });
  }
}
