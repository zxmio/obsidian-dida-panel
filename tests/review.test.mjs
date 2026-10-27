import { test } from "node:test";
import assert from "node:assert/strict";
import { compactTasks, extractJson, idleDays, parseReview, pickReviewTasks } from "../src/review/review.ts";

const NOW = new Date("2026-10-27T12:00:00+08:00");

function task(id, extra = {}) {
  return {
    id,
    projectId: "p1",
    title: `任务${id}`,
    content: null,
    desc: null,
    startDate: null,
    dueDate: null,
    timeZone: null,
    isAllDay: null,
    priority: 0,
    status: 0,
    tags: null,
    columnId: "c1",
    parentId: null,
    childIds: null,
    etag: null,
    kind: "TEXT",
    completedTime: null,
    createdTime: "2026-10-01T10:00:00+0800",
    modifiedTime: "2026-10-01T10:00:00+0800",
    ...extra
  };
}

const projectKey = (id) => (id.startsWith("inbox") ? "inbox" : id);

function known(tasks) {
  return {
    tasks: new Map(tasks.map((t) => [t.id, t])),
    projectIds: new Set(["inbox", "p1", "p2"]),
    columns: new Map([
      ["p1", new Set(["c1", "c2"])],
      ["inbox", new Set(["ic1"])]
    ]),
    projectKey
  };
}

test("未动天数按修改时间算，没有修改时间看创建时间", () => {
  assert.equal(idleDays(task("a"), NOW), 26);
  assert.equal(idleDays(task("b", { modifiedTime: null, createdTime: "2026-10-20T12:00:00+0800" }), NOW), 7);
  assert.equal(idleDays(task("c", { modifiedTime: null, createdTime: null }), NOW), null);
});

test("送审时跳过子任务和已完成，超上限保留最久没动的", () => {
  const list = [
    task("new", { modifiedTime: "2026-10-26T10:00:00+0800" }),
    task("old", { modifiedTime: "2026-03-01T10:00:00+0800" }),
    task("child", { parentId: "old" }),
    task("done", { status: 2 })
  ];
  assert.deepEqual(pickReviewTasks(list, NOW).map((t) => t.id), ["new", "old"]);
  assert.deepEqual(pickReviewTasks(list, NOW, 1).map((t) => t.id), ["old"]);
});

test("压缩清单只带判断需要的字段，备注去掉深链", () => {
  const line = compactTasks(
    [task("a", { priority: 5, tags: ["派给ai"], dueDate: "2026-10-30T00:00:00+0800", repeatFlag: "RRULE:FREQ=DAILY", content: "正文：[x.md](obsidian://open?vault=V&file=x.md) 补充说明", columnName: "选题池" })],
    () => "内容创作",
    NOW
  );
  const row = JSON.parse(line);
  assert.equal(row.项目, "内容创作");
  assert.equal(row.列, "选题池");
  assert.equal(row.优先级, "高");
  assert.equal(row.日期, "2026-10-30");
  assert.equal(row.重复, true);
  assert.equal(row.未动天数, 26);
  assert.ok(!row.备注.includes("obsidian://"));
});

test("校验体检结果：丢掉对不上的 id 与不可执行的动作", () => {
  const tasks = [task("a"), task("b", { projectId: "inbox1010", columnId: "ic1" }), task("c"), task("d")];
  const result = parseReview(
    {
      summary: "收件箱积压",
      findings: [
        { taskId: "ghost", issue: "描述不清", reason: "x", options: [{ label: "改标题", type: "rename", title: "新" }] },
        {
          taskId: "a",
          issue: "描述不清",
          reason: "标题只是名词",
          options: [
            { label: "改标题", type: "rename", title: "整理并发布选题清单" },
            { label: "换列", type: "move_column", columnId: "c1" },
            { label: "移到别处", type: "move_project", projectId: "nope" },
            { label: "排期", type: "set_date", date: "2026-11-02" }
          ]
        },
        { taskId: "b", issue: "分类不当", reason: "属于项目", options: [{ label: "移到项目", type: "move_project", projectId: "p2" }, { label: "回收件箱", type: "move_project", projectId: "inbox" }] },
        { taskId: "c", issue: "疑似重复", reason: "和 a 重复", options: [{ label: "删除", type: "delete" }] },
        { taskId: "d", issue: "乱写的类型", reason: "", options: [{ label: "完成", type: "complete" }] },
        { taskId: "a", issue: "长期搁置", reason: "重复出现", options: [{ label: "完成", type: "complete" }] }
      ]
    },
    known(tasks)
  );
  assert.equal(result.summary, "收件箱积压");
  assert.deepEqual(result.findings.map((f) => f.taskId), ["a", "b"]);
  assert.deepEqual(result.findings[0].options.map((o) => o.action.type), ["rename", "set_date"]);
  assert.deepEqual(result.findings[1].options.map((o) => o.action), [{ type: "move_project", projectId: "p2" }]);
});

test("日期动作：空字符串是清除，格式不对丢掉", () => {
  const tasks = [task("a")];
  const r = parseReview(
    {
      summary: "",
      findings: [
        {
          taskId: "a",
          issue: "过期未处理",
          reason: "",
          options: [
            { label: "清除日期", type: "set_date", date: "" },
            { label: "乱日期", type: "set_date", date: "下周一" },
            { label: "高优先级", type: "set_priority", priority: 5 },
            { label: "原优先级", type: "set_priority", priority: 0 }
          ]
        }
      ]
    },
    known(tasks)
  );
  assert.deepEqual(r.findings[0].options.map((o) => o.action), [{ type: "set_date", date: null }, { type: "set_priority", priority: 5 }]);
});

test("没走结构化输出时从文字里抠 JSON", () => {
  assert.deepEqual(extractJson('结果如下：\n```json\n{"summary":"ok","findings":[]}\n```'), { summary: "ok", findings: [] });
  assert.deepEqual(extractJson('{"summary":"x","findings":[]}'), { summary: "x", findings: [] });
  assert.equal(extractJson("没有 JSON"), null);
  const r = parseReview('```json\n{"summary":"s","findings":[]}\n```', known([]));
  assert.equal(r.summary, "s");
});
