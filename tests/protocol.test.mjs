import { test } from "node:test";
import assert from "node:assert/strict";
import { extractToolResult, parseSseMessages, pickResponse } from "../src/mcp/protocol.ts";
import { camelize, normalizeTask, unwrapResult } from "../src/dida/normalize.ts";

test("SSE 文本里能挑出对应 id 的响应", () => {
  const text = [
    "event: message",
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    "",
    ": keepalive",
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"{\\"result\\":[1,2]}"}]}}',
    ""
  ].join("\n");
  const messages = parseSseMessages(text);
  assert.equal(messages.length, 2);
  const reply = pickResponse(messages, 7);
  assert.ok(reply);
  assert.deepEqual(extractToolResult(reply.result), { result: [1, 2] });
});

test("isError 的工具结果抛出文本", () => {
  assert.throws(() => extractToolResult({ isError: true, content: [{ type: "text", text: "项目不存在" }] }), /项目不存在/);
});

test("structuredContent 优先于 text", () => {
  assert.deepEqual(extractToolResult({ structuredContent: { a: 1 }, content: [{ type: "text", text: "{}" }] }), { a: 1 });
});

test("snake_case 返回会被归一化成 camelCase 任务", () => {
  const raw = {
    id: "1",
    project_id: "inbox1010437297",
    title: "约时间",
    start_date: "2026-10-26T00:00:00+0800",
    due_date: "2026-10-26T00:00:00+0800",
    is_all_day: true,
    priority: 5,
    status: 0,
    column_name: "明确安排",
    etag: "x"
  };
  const task = normalizeTask(raw);
  assert.equal(task.projectId, "inbox1010437297");
  assert.equal(task.dueDate, "2026-10-26T00:00:00+0800");
  assert.equal(task.isAllDay, true);
  assert.equal(task.priority, 5);
  assert.equal(task.columnName, "明确安排");
  assert.equal(task.tags, null);
});

test("非法优先级归为 0，result 包装被拆掉", () => {
  assert.equal(normalizeTask({ id: "1", priority: 4 }).priority, 0);
  assert.deepEqual(unwrapResult({ result: [1] }), [1]);
  assert.deepEqual(unwrapResult({ result: [1], extra: 1 }), { result: [1], extra: 1 });
  assert.deepEqual(camelize({ a_b: { c_d: 1 } }), { aB: { cD: 1 } });
});

test("清单型任务：检查项按顺序归一化，正文取 desc", async () => {
  const { taskBody } = await import("../src/dida/types.ts");
  const t = normalizeTask({
    id: "a",
    title: "清单",
    kind: "CHECKLIST",
    content: "",
    desc: "来源：[笔记](obsidian://open?vault=V&file=a.md)",
    items: [
      { id: "2", title: "第二", status: 1, sortOrder: 1 },
      { id: "1", title: "第一", status: 0, sortOrder: 0 }
    ]
  });
  assert.deepEqual(t.items?.map((i) => [i.id, i.status]), [["1", 0], ["2", 1]]);
  assert.equal(taskBody(t), "来源：[笔记](obsidian://open?vault=V&file=a.md)");
  assert.equal(taskBody({ kind: "TEXT", content: "正文", desc: null }), "正文");
  assert.equal(taskBody({ kind: "TEXT", content: null, desc: "只有描述" }), "只有描述");
});

test("换日期保留时间段", async () => {
  const { rescheduleDates, describeDue } = await import("../src/dida/dates.ts");
  const task = { startDate: "2026-11-02T16:00:00+0800", dueDate: "2026-11-02T17:00:00+0800", isAllDay: false };
  // 只换日子：时刻和一小时时长都留着
  const moved = rescheduleDates(task, new Date(2026, 10, 5));
  assert.equal(new Date(moved.startDate).getHours(), 16);
  assert.equal(new Date(moved.dueDate).getTime() - new Date(moved.startDate).getTime(), 3600_000);
  assert.equal(moved.isAllDay, false);
  // 换成 9 点开始：结束跟着到 10 点
  const at9 = rescheduleDates(task, new Date(2026, 10, 5, 9, 0), false);
  assert.equal(new Date(at9.dueDate).getHours(), 10);
  // 改成全天：不再带时长
  const allDay = rescheduleDates(task, new Date(2026, 10, 5), true);
  assert.equal(allDay.startDate, allDay.dueDate);
  // 跨三天的全天任务挪一天，结束也挪一天
  const span = rescheduleDates({ startDate: "2026-11-02T00:00:00+0800", dueDate: "2026-11-04T00:00:00+0800", isAllDay: true }, new Date(2026, 10, 10));
  assert.equal(new Date(span.dueDate).getDate(), 12);
  assert.match(describeDue(task, new Date(2026, 10, 1)).label, /16:00–17:00/);
});

test("重复规则翻成中文", async () => {
  const { describeRepeat, repeatOptions, sameRule } = await import("../src/dida/repeat.ts");
  assert.equal(describeRepeat("RRULE:FREQ=WEEKLY;BYDAY=MO"), "每周一");
  assert.equal(describeRepeat("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"), "每 2 周一、三");
  assert.equal(describeRepeat("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR"), "每个工作日");
  assert.equal(describeRepeat("RRULE:FREQ=MONTHLY;BYMONTHDAY=5"), "每月 5 日");
  assert.equal(describeRepeat("ERULE:NAME=CUSTOM;BYDATE=20260325"), "重复");
  assert.equal(describeRepeat(""), null);
  const opts = repeatOptions(new Date(2026, 10, 2));
  assert.equal(opts[2].label, "每周一");
  assert.ok(sameRule("RRULE:FREQ=WEEKLY;BYDAY=MO", opts[2].rule));
});
