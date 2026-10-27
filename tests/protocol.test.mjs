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
