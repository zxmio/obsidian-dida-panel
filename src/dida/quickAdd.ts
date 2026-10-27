import type { Priority } from "./types.ts";
import { addDays, startOfDay } from "./dates.ts";

/**
 * 快速添加框的速记语法：
 *   !高 / !中 / !低 / !无（或 !1 !2 !3）    优先级
 *   #标签                                   标签，可多个
 *   ^项目名                                 按名称模糊匹配项目
 *   今天 / 明天 / 后天 / 周三 / 下周一 / 10月3日 / 10-3 / 2026-10-03   日期
 *   14:00 / 14点 / 14点半                   时间（没写日期就算今天）
 * 其余词拼回标题。
 */
export interface QuickAddResult {
  title: string;
  priority: Priority | null;
  tags: string[];
  projectQuery: string | null;
  date: Date | null;
  allDay: boolean;
}

const PRIORITY_WORDS: Record<string, Priority> = {
  高: 5, 中: 3, 低: 1, 无: 0, "1": 5, "2": 3, "3": 1
};
const WEEKDAY_WORDS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0
};

function parseDateWord(token: string, now: Date): Date | null {
  const today = startOfDay(now);
  if (token === "今天" || token === "今日") return today;
  if (token === "明天" || token === "明日") return addDays(today, 1);
  if (token === "后天") return addDays(today, 2);
  if (token === "大后天") return addDays(today, 3);

  const week = /^(下)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(token);
  if (week) {
    const target = WEEKDAY_WORDS[week[2]];
    const current = today.getDay();
    if (week[1]) {
      const monday = addDays(today, current === 0 ? -6 : 1 - current);
      return addDays(monday, 7 + (target === 0 ? 6 : target - 1));
    }
    const ahead = (target - current + 7) % 7;
    return addDays(today, ahead);
  }

  const full = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(token);
  if (full) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]));

  const cn = /^(\d{1,2})月(\d{1,2})[日号]?$/.exec(token);
  const short = /^(\d{1,2})[-/](\d{1,2})$/.exec(token);
  const md = cn ?? short;
  if (md) {
    const d = new Date(today.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    return d < today ? new Date(today.getFullYear() + 1, Number(md[1]) - 1, Number(md[2])) : d;
  }
  return null;
}

function parseTimeWord(token: string): { h: number; m: number } | null {
  const colon = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (colon) {
    const h = Number(colon[1]), m = Number(colon[2]);
    return h < 24 && m < 60 ? { h, m } : null;
  }
  const cn = /^(\d{1,2})点(半|\d{1,2}分?)?$/.exec(token);
  if (cn) {
    const h = Number(cn[1]);
    if (h >= 24) return null;
    const m = cn[2] === "半" ? 30 : cn[2] ? Number(cn[2].replace("分", "")) : 0;
    return m < 60 ? { h, m } : null;
  }
  return null;
}

export function parseQuickAdd(input: string, now: Date = new Date()): QuickAddResult {
  const result: QuickAddResult = { title: "", priority: null, tags: [], projectQuery: null, date: null, allDay: true };
  const words: string[] = [];
  let time: { h: number; m: number } | null = null;

  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    if (token.length > 1 && token.startsWith("!") && token.slice(1) in PRIORITY_WORDS) {
      result.priority = PRIORITY_WORDS[token.slice(1)];
      continue;
    }
    if (token.length > 1 && token.startsWith("#")) {
      result.tags.push(token.slice(1));
      continue;
    }
    if (token.length > 1 && token.startsWith("^")) {
      result.projectQuery = token.slice(1);
      continue;
    }
    const date = parseDateWord(token, now);
    if (date) {
      result.date = date;
      continue;
    }
    const t = parseTimeWord(token);
    if (t) {
      time = t;
      continue;
    }
    words.push(token);
  }

  if (time) {
    const base = result.date ?? startOfDay(now);
    result.date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), time.h, time.m);
    result.allDay = false;
  }
  result.title = words.join(" ");
  return result;
}

export type QuickTokenKind = "date" | "time" | "priority" | "project";

function tokenKind(token: string, now: Date): QuickTokenKind | "tag" | null {
  if (token.length > 1 && token.startsWith("!") && token.slice(1) in PRIORITY_WORDS) return "priority";
  if (token.length > 1 && token.startsWith("#")) return "tag";
  if (token.length > 1 && token.startsWith("^")) return "project";
  if (parseDateWord(token, now)) return "date";
  if (parseTimeWord(token)) return "time";
  return null;
}

/**
 * 快捷按钮改速记：去掉同类的旧词，把新词接到末尾；token 为 null 时只删除。
 * 输入框里的文字始终是唯一的事实源，按钮只是帮忙写速记。
 */
export function setQuickToken(input: string, kind: QuickTokenKind, token: string | null, now: Date = new Date()): string {
  const kept = input.split(/\s+/).filter((w) => w && tokenKind(w, now) !== kind);
  if (token) kept.push(token);
  return kept.join(" ") + (kept.length ? " " : "");
}

/** 标签按钮：有就去掉，没有就加上。 */
export function toggleQuickTag(input: string, tag: string): string {
  const words = input.split(/\s+/).filter(Boolean);
  const hit = `#${tag}`;
  const next = words.includes(hit) ? words.filter((w) => w !== hit) : [...words, hit];
  return next.join(" ") + (next.length ? " " : "");
}

/** 项目名里的空格会把速记词拆开，写进输入框前去掉。 */
export function projectToken(name: string): string {
  return `^${name.replace(/\s+/g, "")}`;
}

/**
 * 日历选中的日期写成速记词：今年且不早于今天写「11月3日」，其余写完整日期，
 * 免得「月日」被解析成明年。
 */
export function dateToken(d: Date, now: Date = new Date()): string {
  const today = startOfDay(now);
  if (d.getFullYear() === today.getFullYear() && startOfDay(d) >= today) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function timeToken(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
