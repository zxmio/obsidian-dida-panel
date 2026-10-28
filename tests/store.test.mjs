import { test } from "node:test";
import assert from "node:assert/strict";
import { DidaStore } from "../src/store.ts";

function fakeApi(columns, tasks = []) {
  const calls = [];
  return {
    calls,
    async getProjectWithTasks(id) {
      return { project: { id, name: id, color: null, closed: null, groupId: null, viewMode: "kanban", kind: "TASK" }, tasks, columns };
    },
    async createColumn(projectId, name, sortOrder) {
      calls.push({ projectId, name, sortOrder });
      return { id: "new", projectId, name, sortOrder: sortOrder ?? 0 };
    }
  };
}

const options = { hideSeparators: () => true, completedRange: () => "none" };

test("新建分组排在最后，并立刻出现在本地缓存里", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = fakeApi([
    { id: "a", projectId: "p1", name: "收集箱", sortOrder: -100 },
    { id: "b", projectId: "p1", name: "进行中", sortOrder: 0 }
  ]);
  const store = new DidaStore(api, options);
  await store.loadProject("p1");
  await store.createColumn("p1", "已发布");
  assert.deepEqual(api.calls, [{ projectId: "p1", name: "已发布", sortOrder: 2 ** 40 }]);
  assert.deepEqual(store.getProject("p1").columns.map((c) => c.name), ["收集箱", "进行中", "已发布"]);
});

test("收件箱建分组用真实的 inbox id；没有分组时不传排序", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = fakeApi([], [{ id: "t1", projectId: "inbox1010437297", title: "x", status: 0, tags: null }]);
  const store = new DidaStore(api, options);
  await store.loadProject("inbox");
  await store.createColumn("inbox", "待办收集");
  assert.deepEqual(api.calls, [{ projectId: "inbox1010437297", name: "待办收集", sortOrder: undefined }]);
});

test("子任务：刚建的子任务马上算进父任务下，已完成的不算", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = { id: "p", projectId: "p1", title: "父", status: 0, parentId: null, childIds: ["c1", "c2"], tags: null, sortOrder: 0 };
  const done = { id: "c1", projectId: "p1", title: "已完成", status: 2, parentId: "p", tags: null, sortOrder: 1 };
  const api = fakeApi([], [parent, done]);
  api.createTask = async (input) => ({ id: "c3", projectId: input.projectId, title: input.title, status: 0, parentId: input.parentId, tags: [], sortOrder: 5, columnId: null });
  const store = new DidaStore(api, options);
  await store.loadProject("p1");
  assert.deepEqual(store.childrenOf("p").map((c) => c.id), []);
  await store.createTask({ title: "新子任务", projectId: "p1", parentId: "p", priority: 0, tags: [], content: "" });
  assert.deepEqual(store.childrenOf("p").map((c) => c.title), ["新子任务"]);
});

test("子任务进度：删掉的子任务 id 残留在 childIds 里，不算进总数", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = { id: "p", projectId: "p1", title: "父", status: 0, parentId: null, childIds: ["gone1", "gone2", "done1", "moved", "open1"], tags: null, sortOrder: 0 };
  const open = { id: "open1", projectId: "p1", title: "未完成", status: 0, parentId: "p", tags: null, sortOrder: 1 };
  const api = fakeApi([], [parent, open]);
  const remote = {
    done1: { id: "done1", status: 2, parentId: "p" },
    moved: { id: "moved", status: 0, parentId: "other" }
  };
  const fetched = [];
  api.getTask = async (id) => {
    fetched.push(id);
    if (remote[id]) return remote[id];
    throw new Error("TickTick API error [resource_not_found]: task not found");
  };
  const store = new DidaStore(api, options);
  await store.loadProject("p1");
  let emitted = 0;
  store.subscribe(() => (emitted += 1));
  // 第一次只数得出缓存里未完成的，其余在后台查
  assert.deepEqual(store.subtaskProgress(parent), { done: 0, total: 1 });
  await new Promise((r) => setImmediate(r));
  assert.ok(emitted > 0);
  assert.deepEqual(store.subtaskProgress(parent), { done: 1, total: 2 });
  // 查过的不再重复查
  assert.deepEqual(fetched.sort(), ["done1", "gone1", "gone2", "moved"]);
});

test("新建任务：立刻出现在当前项目里，后台重拉期间旧数据不清空", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const existing = { id: "t1", projectId: "p1", title: "旧任务", status: 0, parentId: null, tags: null, sortOrder: 0 };
  const api = fakeApi([], [existing]);
  api.createTask = async (input) => ({ id: "t2", projectId: input.projectId, title: input.title, status: 0, parentId: null, tags: [], sortOrder: 1, columnId: null });
  api.listTodayTasks = async () => [];
  api.listOverdueTasks = async () => [];
  const store = new DidaStore(api, options);
  await store.loadProject("p1");
  const seen = [];
  store.subscribe(() => seen.push(store.getProject("p1")?.tasks.map((x) => x.title) ?? null));
  await store.createTask({ title: "新任务", projectId: "p1", priority: 0, tags: [], content: "" });
  assert.deepEqual(seen[0], ["旧任务", "新任务"]);
  await new Promise((r) => setImmediate(r));
  // 重拉回来的（服务器还没读到新任务，靠待确认列表补上）和手上一样，不再重画，也从没出现过空项目
  assert.ok(seen.every((titles) => titles !== null && titles.length === 2));
  assert.equal(seen.length, 1);
});

test("项目：新建立刻进列表，归档立刻从列表和缓存里拿掉", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = fakeApi([]);
  const sent = [];
  api.createProject = async (input) => ({ id: "np", name: input.name, color: null, closed: null, groupId: input.groupId ?? null, viewMode: input.viewMode, kind: "TASK" });
  api.updateProject = async (id, patch) => {
    sent.push({ id, patch });
    return null;
  };
  const store = new DidaStore(api, options);
  await store.createProject({ name: "📕 新项目", viewMode: "kanban" });
  assert.ok(store.projectById("np"));
  await store.updateProject("np", { name: "改名了" });
  assert.equal(store.projectById("np").name, "改名了");
  await store.loadProject("np");
  await store.updateProject("np", { closed: true });
  assert.equal(store.projects.some((p) => p.id === "np"), false);
  assert.equal(store.getProject("np"), null);
  assert.deepEqual(sent.map((s) => s.patch), [{ name: "改名了" }, { closed: true }]);
});

test("分组插入位置：左边、右边取中点，两端外推，找不到排最后", async () => {
  const { columnSortOrder } = await import("../src/store.ts");
  const cols = [
    { id: "a", sortOrder: 0 },
    { id: "b", sortOrder: 100 },
    { id: "c", sortOrder: 300 }
  ];
  assert.equal(columnSortOrder(cols, { before: "b" }), 50);
  assert.equal(columnSortOrder(cols, { after: "b" }), 200);
  assert.equal(columnSortOrder(cols, { before: "a" }), -(2 ** 40));
  assert.equal(columnSortOrder(cols, { after: "c" }), 300 + 2 ** 40);
  assert.equal(columnSortOrder(cols, {}), 300 + 2 ** 40);
  assert.equal(columnSortOrder([], {}), undefined);
});
