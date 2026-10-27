import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedToolPatterns, classifyTool, describeToolCall, disallowedTools, didaToolName, toolLabel } from "../src/agent/permissions.ts";
import { buildSystemPrompt } from "../src/agent/systemPrompt.ts";

test("工具三档分类：查询与单条写入放行，删除与批量确认，文件与命令禁止", () => {
  assert.equal(classifyTool("mcp__dida365__list_projects"), "allow");
  assert.equal(classifyTool("mcp__dida365__create_task"), "allow");
  assert.equal(classifyTool("mcp__dida365__update_task"), "allow");
  assert.equal(classifyTool("mcp__dida365__delete_task"), "confirm");
  assert.equal(classifyTool("mcp__dida365__batch_update_tasks"), "confirm");
  assert.equal(classifyTool("mcp__dida365__move_task"), "confirm");
  assert.equal(classifyTool("mcp__dida365__some_future_tool"), "confirm");
  assert.equal(classifyTool("Read"), "allow");
  assert.equal(classifyTool("Bash"), "deny");
  assert.equal(classifyTool("Write"), "deny");
  assert.equal(classifyTool("mcp__supabase__execute_sql"), "deny");
});

test("放行与禁用清单不重叠，放行名单只含滴答自动工具与只读内置工具", () => {
  const allowed = allowedToolPatterns();
  const denied = disallowedTools();
  assert.ok(allowed.includes("mcp__dida365__create_task"));
  assert.ok(!allowed.includes("mcp__dida365__delete_task"));
  assert.ok(allowed.includes("Read"));
  assert.ok(denied.includes("Bash"));
  assert.ok(allowed.every((t) => !denied.includes(t)));
  assert.equal(didaToolName("mcp__dida365__fetch"), "fetch");
  assert.equal(didaToolName("Read"), null);
});

test("确认框文案用任务标题而不是 id", () => {
  const titleOf = (id) => (id === "t1" ? "给苏达提供合作资料" : null);
  const d = describeToolCall("mcp__dida365__delete_task", { project_id: "p", task_id: "t1" }, titleOf);
  assert.equal(d.title, "删除待办");
  assert.deepEqual(d.lines, ["给苏达提供合作资料"]);
  const b = describeToolCall("mcp__dida365__complete_tasks_in_project", { project_id: "p", task_ids: ["t1", "t2"] }, titleOf);
  assert.equal(b.title, "完成 2 条待办");
  assert.deepEqual(b.lines, ["给苏达提供合作资料", "t2"]);
});

test("工具步骤标签说人话", () => {
  assert.equal(toolLabel("mcp__dida365__create_task", { task: { title: "写周报" } }), "新建：写周报");
  assert.equal(toolLabel("mcp__dida365__filter_tasks", { filter: { tag: ["派给AI"] } }), "按标签筛选：派给AI");
  assert.equal(toolLabel("mcp__dida365__list_undone_tasks_by_time_query", { query_command: "today" }), "查今天的待办");
  assert.equal(toolLabel("Read", { file_path: "a/b/c.md" }), "读笔记 c.md");
});

test("系统提示带上当前项目、看板列、展开任务与当前笔记", () => {
  const prompt = buildSystemPrompt({
    today: "2026-10-27",
    weekday: "周二",
    timeZone: "Asia/Shanghai",
    vaultName: "Todaylab",
    currentNotePath: "03内容输出/公众号/x.md",
    tab: "项目详情",
    project: { id: "66f4", name: "内容创作", viewMode: "kanban", columns: [{ id: "c1", name: "选题池" }, { id: "c2", name: "写作中" }] },
    expandedTask: { id: "t9", title: "我的 AI 设计工具包" },
    queueTag: "派给AI"
  });
  assert.ok(prompt.includes("当前项目：内容创作（id 66f4，看板）"));
  assert.ok(prompt.includes("选题池(c1)"));
  assert.ok(prompt.includes("我的 AI 设计工具包"));
  assert.ok(prompt.includes("03内容输出/公众号/x.md"));
  assert.ok(prompt.includes("obsidian://open?vault=Todaylab"));
  assert.ok(prompt.includes("complete_task"));
  const bare = buildSystemPrompt({ today: "2026-10-27", weekday: "周二", timeZone: "Asia/Shanghai", vaultName: "V", currentNotePath: null, tab: "今天", project: null, expandedTask: null, queueTag: "派给AI" });
  assert.ok(!bare.includes("当前项目"));
  assert.ok(!bare.includes("当前打开的笔记"));
});
