import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd } from "../src/dida/quickAdd.ts";

// 2026-10-26 是周一
const now = new Date(2026, 9, 26, 9, 30);

test("纯标题不带任何修饰", () => {
  const r = parseQuickAdd("给魔兔补测试账号", now);
  assert.equal(r.title, "给魔兔补测试账号");
  assert.equal(r.priority, null);
  assert.deepEqual(r.tags, []);
  assert.equal(r.projectQuery, null);
  assert.equal(r.date, null);
});

test("优先级、标签、项目速记都能摘出来", () => {
  const r = parseQuickAdd("写公众号 !高 #公众号 #近期重点 ^内容", now);
  assert.equal(r.title, "写公众号");
  assert.equal(r.priority, 5);
  assert.deepEqual(r.tags, ["公众号", "近期重点"]);
  assert.equal(r.projectQuery, "内容");
});

test("数字优先级：!1 高 !2 中 !3 低", () => {
  assert.equal(parseQuickAdd("a !1", now).priority, 5);
  assert.equal(parseQuickAdd("a !2", now).priority, 3);
  assert.equal(parseQuickAdd("a !3", now).priority, 1);
  assert.equal(parseQuickAdd("a !无", now).priority, 0);
});

test("明天 14:00 是带时间的非全天任务", () => {
  const r = parseQuickAdd("回复客户 明天 14:00", now);
  assert.equal(r.title, "回复客户");
  assert.equal(r.allDay, false);
  assert.equal(r.date.getFullYear(), 2026);
  assert.equal(r.date.getMonth(), 9);
  assert.equal(r.date.getDate(), 27);
  assert.equal(r.date.getHours(), 14);
  assert.equal(r.date.getMinutes(), 0);
});

test("只有时间就默认今天", () => {
  const r = parseQuickAdd("开会 16点半", now);
  assert.equal(r.date.getDate(), 26);
  assert.equal(r.date.getHours(), 16);
  assert.equal(r.date.getMinutes(), 30);
  assert.equal(r.allDay, false);
});

test("周三取本周三，下周一取下一周的周一", () => {
  const wed = parseQuickAdd("x 周三", now).date;
  assert.equal(wed.getDate(), 28);
  const nextMon = parseQuickAdd("x 下周一", now).date;
  assert.equal(nextMon.getDate(), 2);
  assert.equal(nextMon.getMonth(), 10);
  // 今天是周一，「周一」取今天而不是下周
  assert.equal(parseQuickAdd("x 周一", now).date.getDate(), 26);
});

test("月日写法过了今年就顺延到明年", () => {
  const r = parseQuickAdd("年度复盘 1月3日", now);
  assert.equal(r.date.getFullYear(), 2027);
  assert.equal(r.date.getMonth(), 0);
  assert.equal(r.date.getDate(), 3);
  assert.equal(parseQuickAdd("x 11-5", now).date.getMonth(), 10);
  assert.equal(parseQuickAdd("x 2026-12-01", now).date.getDate(), 1);
});

test("单独的 # ! ^ 字符留在标题里", () => {
  const r = parseQuickAdd("C# 语法 ! ^", now);
  assert.equal(r.title, "C# 语法 ! ^");
});
