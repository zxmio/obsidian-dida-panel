export const CLEAR_DATE = "1970-01-01T00:00:00.000+0000";
const DAY_MS = 86_400_000;
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function tzOffsetString(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** 滴答接口要求日期带时区，形如 2026-10-26T14:00:00+0800。 */
export function formatDidaDate(d: Date, allDay: boolean): string {
  const base = allDay ? startOfDay(d) : d;
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}:${pad(base.getSeconds())}${tzOffsetString(base)}`;
}

export function parseDidaDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function dayDiff(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

export function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeInputValue(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

export interface TaskDates {
  startDate: string;
  dueDate: string;
  isAllDay: boolean;
}

/**
 * 给任务换日期时算出新的开始、结束。滴答的时间段任务（16:00–17:00、跨几天的全天任务）开始和结束不同，
 * 只改一头会把时长丢掉，所以按原来的时长把结束跟着挪。
 * allDay 不传：只换日子，原来的时刻和全天与否都保留；传了就按 next 本身的时刻（全天时忽略时刻）。
 * next 为空是清除日期。
 */
export function rescheduleDates(
  task: { startDate: string | null; dueDate: string | null; isAllDay: boolean | null },
  next: Date | null,
  allDay?: boolean
): TaskDates {
  if (!next) return { startDate: CLEAR_DATE, dueDate: CLEAR_DATE, isAllDay: true };
  const oldStart = parseDidaDate(task.startDate ?? task.dueDate);
  const oldDue = parseDidaDate(task.dueDate ?? task.startDate);
  const oldAllDay = task.isAllDay !== false;
  let start: Date;
  let nextAllDay: boolean;
  if (allDay === undefined) {
    nextAllDay = oldStart ? oldAllDay : true;
    start = startOfDay(next);
    if (oldStart && !nextAllDay) start.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
  } else {
    nextAllDay = allDay;
    start = allDay ? startOfDay(next) : new Date(next);
  }
  // 全天与否变了，原来的时长就不再有意义（比如定时的一小时改成全天），只留单点
  const span = oldStart && oldDue && oldAllDay === nextAllDay ? Math.max(0, oldDue.getTime() - oldStart.getTime()) : 0;
  const due = new Date(start.getTime() + span);
  return { startDate: formatDidaDate(start, nextAllDay), dueDate: formatDidaDate(due, nextAllDay), isAllDay: nextAllDay };
}

export type DueState = "none" | "overdue" | "today" | "tomorrow" | "future";

export interface DueInfo {
  state: DueState;
  label: string;
  date: Date | null;
}

/** 任务的截止日期描述：今天 / 明天 / 周三 / 10月3日，过期则给出天数。 */
export function describeDue(
  task: { dueDate: string | null; startDate: string | null; isAllDay: boolean | null },
  now: Date = new Date()
): DueInfo {
  const d = parseDidaDate(task.dueDate ?? task.startDate);
  if (!d) return { state: "none", label: "", date: null };
  const diff = dayDiff(now, d);
  const start = parseDidaDate(task.startDate);
  const hm = (x: Date): string => `${pad(x.getHours())}:${pad(x.getMinutes())}`;
  // 同一天里的时间段显示成 16:00–17:00
  const range = !!start && start.getTime() < d.getTime() && dayDiff(start, d) === 0;
  const time = task.isAllDay ? "" : range && start ? `${hm(start)}–${hm(d)}` : hm(d);
  const withTime = (day: string): string => (time ? `${day} ${time}` : day);
  if (diff < 0) {
    const label = diff === -1 ? "昨天" : diff > -7 ? `${-diff} 天前` : `${d.getMonth() + 1}月${d.getDate()}日`;
    return { state: "overdue", label: withTime(label), date: d };
  }
  if (diff === 0) return { state: "today", label: time || "今天", date: d };
  if (diff === 1) return { state: "tomorrow", label: withTime("明天"), date: d };
  if (diff < 7) return { state: "future", label: withTime(WEEKDAY[d.getDay()]), date: d };
  return { state: "future", label: withTime(`${d.getMonth() + 1}月${d.getDate()}日`), date: d };
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return "刚刚";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
