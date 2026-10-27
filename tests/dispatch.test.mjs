import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDispatchPrompt, isQueued, withQueueTag, withoutQueueTag } from "../src/dispatch/prompt.ts";
import { linkedPaths, obsidianLinksToWikilinks } from "../src/dida/deeplink.ts";

const now = new Date(2026, 9, 27, 9, 0);
const task = {
  id: "1",
  projectId: "p1",
  title: "公众号：用 Claude Code 做滴答清单插件",
  content:
    "正文：[03内容输出/公众号/用 Claude Code 做滴答清单插件.md](obsidian://open?vault=Todaylab&file=03%E5%86%85%E5%AE%B9%E8%BE%93%E5%87%BA%2F%E5%85%AC%E4%BC%97%E5%8F%B7%2F%E7%94%A8%20Claude%20Code%20%E5%81%9A%E6%BB%B4%E7%AD%94%E6%B8%85%E5%8D%95%E6%8F%92%E4%BB%B6.md)\n来源：待补",
  desc: null,
  startDate: "2026-10-28T00:00:00+0800",
  dueDate: "2026-10-28T00:00:00+0800",
  timeZone: "Asia/Shanghai",
  isAllDay: true,
  priority: 5,
  status: 0,
  tags: ["公众号", "派给AI"],
  columnId: "c1",
  parentId: null,
  childIds: null,
  etag: "x",
  kind: "TEXT",
  completedTime: null
};

test("深链改写成 wikilink，路径解码、显示名去掉 .md", () => {
  const out = obsidianLinksToWikilinks(task.content);
  assert.ok(out.includes("[[03内容输出/公众号/用 Claude Code 做滴答清单插件.md|用 Claude Code 做滴答清单插件]]"));
  assert.ok(!out.includes("obsidian://"));
  assert.deepEqual(linkedPaths(task.content), ["03内容输出/公众号/用 Claude Code 做滴答清单插件.md"]);
});

test("默认模板：带齐标题、项目、列、截止、优先级、标签（不含队列标签）、备注、相关笔记", () => {
  const prompt = buildDispatchPrompt(task, {
    projectName: "内容创作",
    columnName: "写作中",
    tagLabels: ["公众号", "派给AI"],
    queueTag: "派给AI",
    vaultName: "Todaylab",
    now
  });
  assert.ok(prompt.includes("待办：公众号：用 Claude Code 做滴答清单插件"));
  assert.ok(prompt.includes("所在：内容创作 / 写作中"));
  assert.ok(prompt.includes("截止：明天"));
  assert.ok(prompt.includes("优先级：高"));
  assert.ok(prompt.includes("标签：公众号"));
  assert.ok(!prompt.includes("派给AI"));
  assert.ok(prompt.includes("相关笔记：[[03内容输出/公众号/用 Claude Code 做滴答清单插件.md|用 Claude Code 做滴答清单插件]]"));
  assert.ok(prompt.includes("来源：待补"));
});

test("空字段所在的行收掉，自定义模板生效", () => {
  const bare = { ...task, content: "", dueDate: null, startDate: null, priority: 0, tags: [], columnId: null };
  const prompt = buildDispatchPrompt(bare, { projectName: "收件箱", columnName: null, tagLabels: [], queueTag: "派给AI", vaultName: "Todaylab", now });
  assert.ok(!prompt.includes("截止："));
  assert.ok(!prompt.includes("标签："));
  assert.ok(!prompt.includes("相关笔记："));
  assert.ok(!prompt.includes("备注："));
  assert.ok(prompt.includes("所在：收件箱"));
  const custom = buildDispatchPrompt(bare, { projectName: "收件箱", columnName: null, tagLabels: [], queueTag: "派给AI", vaultName: "Todaylab", template: "做：{{title}}", now });
  assert.equal(custom, "做：公众号：用 Claude Code 做滴答清单插件");
});

test("队列标签的加减与判断", () => {
  assert.deepEqual(withQueueTag(["公众号"], "派给AI"), ["公众号", "派给AI"]);
  assert.deepEqual(withQueueTag(["派给AI"], "派给AI"), ["派给AI"]);
  assert.deepEqual(withQueueTag(null, "派给AI"), ["派给AI"]);
  assert.deepEqual(withoutQueueTag(["公众号", "派给AI"], "派给AI"), ["公众号"]);
  assert.equal(isQueued(task, "派给AI"), true);
  assert.equal(isQueued({ ...task, tags: null }, "派给AI"), false);
});
