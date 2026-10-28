import { setIcon } from "obsidian";
import { addDays, startOfDay } from "../dida/dates.ts";
import { timeToken } from "../dida/quickAdd.ts";
import { QuickPopover } from "./quickPopover.ts";

/**
 * 日期面板：常用日期、月历、常用时刻、清除。快速添加的日期按钮、编辑弹窗、任务操作面板共用这一个，
 * 选什么由调用方决定怎么写回（快速添加改写速记，另外两处直接改任务）。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TIMES: [number, number][] = [[9, 0], [12, 0], [14, 0], [18, 0], [20, 0]];

export function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function dayHint(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

export interface DatePanelValue {
  date: Date | null;
  allDay: boolean;
}

export interface DatePanelHandlers {
  /** 选了某天；word 是常用日期的叫法（今天、明天、周六、下周一），速记用得上 */
  day: (d: Date, word?: string) => void;
  /** 选了时刻；null 是全天 */
  time: (hm: [number, number] | null) => void;
  clear: () => void;
}

/** 日历翻到哪个月由调用方保管，面板重画时不丢。 */
export interface CalendarState {
  month: Date | null;
}

export function renderDatePanel(pop: QuickPopover, body: HTMLElement, cal: CalendarState, value: DatePanelValue, on: DatePanelHandlers): void {
  const today = startOfDay(new Date());
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
    pop.item(quick, { icon, label, hint: dayHint(d), checked: !!value.date && sameDay(value.date, d), onSelect: () => on.day(d, word) });
  }

  renderCalendar(pop, pop.section(body, undefined), cal, value.date, today, (d) => on.day(d));

  const timeSec = pop.section(body, "时间");
  const grid = timeSec.createDiv({ cls: "dida-pop-times" });
  const current = value.date && !value.allDay ? timeToken(value.date.getHours(), value.date.getMinutes()) : null;
  const timeBtn = (text: string, active: boolean, onClick: () => void): void => {
    const b = grid.createEl("button", { cls: "dida-pop-time", text, attr: { type: "button" } });
    b.toggleClass("is-active", active);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
  };
  timeBtn("全天", !current, () => on.time(null));
  for (const [h, m] of TIMES) {
    const token = timeToken(h, m);
    timeBtn(token, current === token, () => on.time([h, m]));
  }
  const custom = grid.createEl("input", { cls: "dida-pop-time-input", type: "time", attr: { "aria-label": "自定义时间" } });
  if (current && !TIMES.some(([h, m]) => timeToken(h, m) === current)) {
    custom.value = current;
    custom.addClass("is-active");
  }
  custom.addEventListener("change", () => {
    const [h, m] = custom.value.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) on.time([h, m]);
  });

  if (value.date) {
    const foot = pop.section(body);
    pop.item(foot, { icon: "calendar-x", label: "清除日期和时间", cls: "is-muted", onSelect: () => on.clear() });
  }
}

function renderCalendar(pop: QuickPopover, sec: HTMLElement, cal: CalendarState, selected: Date | null, today: Date, setDate: (d: Date) => void): void {
  const month = cal.month ?? new Date(today.getFullYear(), today.getMonth(), 1);
  const head = sec.createDiv({ cls: "dida-cal-head" });
  head.createSpan({ cls: "dida-cal-title", text: `${month.getFullYear()}年${month.getMonth() + 1}月` });
  const nav = head.createDiv({ cls: "dida-cal-nav" });
  const navBtn = (icon: string, label: string, delta: number): void => {
    const b = nav.createEl("button", { cls: "dida-cal-btn", attr: { type: "button", "aria-label": label } });
    if (icon) setIcon(b, icon);
    else b.setText(label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      cal.month = delta === 0 ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(month.getFullYear(), month.getMonth() + delta, 1);
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

/**
 * 独立打开的日期面板（编辑弹窗、任务操作面板用）。选一天保留原来的时刻；先选时刻没有日期时落在今天。
 * 每次选择都回调 onPick 并关掉面板。传了 parent 就作为它的二级面板贴在旁边打开。
 */
export function openDatePicker(
  doc: Document,
  rect: DOMRect,
  value: DatePanelValue,
  onPick: (next: DatePanelValue) => void,
  nest?: { parent: QuickPopover; trigger: HTMLElement; onClose: () => void }
): QuickPopover {
  const base = value.date ?? new Date();
  const cal: CalendarState = { month: new Date(base.getFullYear(), base.getMonth(), 1) };
  const done = (next: DatePanelValue): void => {
    pop.close();
    onPick(next);
  };
  const withTime = (d: Date, hm: [number, number] | null): Date => {
    const out = startOfDay(d);
    if (hm) out.setHours(hm[0], hm[1], 0, 0);
    return out;
  };
  const keep = value.date && !value.allDay ? ([value.date.getHours(), value.date.getMinutes()] as [number, number]) : null;
  const pop: QuickPopover = new QuickPopover(doc, rect, {
    cls: "is-date",
    render: (p, body) =>
      renderDatePanel(p, body, cal, value, {
        day: (d) => done({ date: withTime(d, keep), allDay: !keep }),
        time: (hm) => done({ date: withTime(value.date ?? new Date(), hm), allDay: !hm }),
        clear: () => done({ date: null, allDay: true })
      }),
    onClose: () => nest?.onClose(),
    parent: nest?.parent,
    trigger: nest?.trigger
  });
  return pop;
}
