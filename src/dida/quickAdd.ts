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
