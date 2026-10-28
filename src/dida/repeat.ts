/**
 * 重复规则：滴答用 RRULE 字符串（RRULE:FREQ=WEEKLY;BYDAY=MO）。
 * 这里只出常用的几档给人选，读的时候尽量把滴答里设好的规则（含间隔、多个星期几）翻成中文。
 * 纯函数，不依赖 Obsidian，方便单测。
 */

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
const WORKDAYS = "MO,TU,WE,TH,FR";

export interface RepeatOption {
  label: string;
  /** 空字符串是不重复 */
  rule: string;
}

/** 以 base 这天为准的常用档：每天、工作日、每周 X、每月 X 日、每年 M 月 D 日 */
export function repeatOptions(base: Date): RepeatOption[] {
  const day = base.getDay();
  return [
    { label: "每天", rule: "RRULE:FREQ=DAILY;INTERVAL=1" },
    { label: "每个工作日", rule: `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=${WORKDAYS}` },
    { label: `每周${DAY_NAMES[day]}`, rule: `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=${DAY_CODES[day]}` },
    { label: `每月 ${base.getDate()} 日`, rule: `RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${base.getDate()}` },
    { label: `每年 ${base.getMonth() + 1} 月 ${base.getDate()} 日`, rule: "RRULE:FREQ=YEARLY;INTERVAL=1" }
  ];
}

function parts(rule: string): Map<string, string> {
  const body = rule.replace(/^RRULE:/i, "");
  const map = new Map<string, string>();
  for (const seg of body.split(";")) {
    const [k, v] = seg.split("=");
    if (k && v !== undefined) map.set(k.toUpperCase(), v.toUpperCase());
  }
  return map;
}

/** 规则的中文说法；不是 RRULE（比如 ERULE 自定义日期）或看不懂的给「重复」 */
export function describeRepeat(rule: string | null | undefined): string | null {
  if (!rule) return null;
  if (!/^RRULE:/i.test(rule)) return "重复";
  const p = parts(rule);
  const n = Math.max(1, Number(p.get("INTERVAL") ?? 1) || 1);
  const every = (unit: string): string => (n === 1 ? `每${unit}` : `每 ${n} ${unit}`);
  switch (p.get("FREQ")) {
    case "DAILY":
      return n === 1 ? "每天" : `每 ${n} 天`;
    case "WEEKLY": {
      const days = (p.get("BYDAY") ?? "").split(",").filter(Boolean);
      if (days.join(",") === WORKDAYS && n === 1) return "每个工作日";
      const names = days.map((d) => DAY_NAMES[DAY_CODES.indexOf(d)]).filter(Boolean);
      return names.length ? `${every("周")}${names.join("、")}` : every("周");
    }
    case "MONTHLY": {
      const md = p.get("BYMONTHDAY");
      return md ? `${every("月")} ${md} 日` : every("月");
    }
    case "YEARLY":
      return every("年");
    default:
      return "重复";
  }
}

/** 某条规则是不是常用档里的某一档（两边都去掉 INTERVAL=1 再比，滴答回来的规则可能不带它） */
export function sameRule(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (r: string | null | undefined): string => (r ?? "").toUpperCase().replace(/;INTERVAL=1(?=;|$)/, "");
  return norm(a) === norm(b);
}
