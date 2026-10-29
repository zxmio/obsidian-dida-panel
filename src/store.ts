import type { DidaApi } from "./dida/api.ts";
import { addDays, describeDue, startOfDay } from "./dida/dates.ts";
import { INBOX_ID, isInboxId, type DidaColumn, type DidaProject, type DidaProjectGroup, type DidaTag, type DidaTask, type ProjectInput, type TaskInput } from "./dida/types.ts";

export interface ProjectSnapshot {
  project: DidaProject;
  tasks: DidaTask[];
  /** 近 30 天完成的，只在打开「显示已完成」时拉 */
  completed: DidaTask[];
  columns: DidaColumn[];
  fetchedAt: number;
}

export interface TodaySnapshot {
  overdue: DidaTask[];
  today: DidaTask[];
  completed: DidaTask[];
  fetchedAt: number;
}

export type CompletedRange = "today" | "week" | "none";

export interface ProjectCount {
  undone: number;
  overdue: number;
}

export interface OverviewSnapshot {
  counts: Map<string, ProjectCount>;
  /** 全部未完成任务，供 AI 队列这类跨项目视图用 */
  tasks: DidaTask[];
  totalUndone: number;
  totalOverdue: number;
  fetchedAt: number;
}

export interface StoreOptions {
  hideSeparators: () => boolean;
  completedRange: () => CompletedRange;
  showCompleted: () => boolean;
}

const sameData = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const INBOX_PROJECT: DidaProject = {
  id: INBOX_ID,
  name: "收件箱",
  color: null,
  closed: null,
  groupId: null,
  viewMode: "list",
  kind: "TASK"
};

/** 新分组的排序值：插在 before 左边、after 右边，或者排到最后；没有分组时交给滴答。 */
export function columnSortOrder(sorted: DidaColumn[], at: { before?: string; after?: string }): number | undefined {
  if (!sorted.length) return undefined;
  const STEP = 2 ** 40;
  const i = sorted.findIndex((c) => c.id === (at.before ?? at.after));
  if (i < 0) return Math.round(sorted[sorted.length - 1].sortOrder) + STEP;
  const [left, right] = at.before ? [sorted[i - 1], sorted[i]] : [sorted[i], sorted[i + 1]];
  if (!left) return Math.round(right.sortOrder) - STEP;
  if (!right) return Math.round(left.sortOrder) + STEP;
  return Math.round((left.sortOrder + right.sortOrder) / 2);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** 新建任务在本地补位的最长时间；滴答通常几秒内就能读到 */
const PENDING_TTL = 2 * 60_000;

/** 名字只有方块符号的空项目是侧栏视觉分隔符，不当项目用。 */
export function isSeparatorProject(name: string): boolean {
  return /^[\s▫◻▪◼□■️]+$/.test(name);
}

/** 所有视图共用的内存缓存。数据源是滴答，这里只做缓存和变更后的失效。 */
export class DidaStore {
  projects: DidaProject[] = [];
  groups: DidaProjectGroup[] = [];
  tags: DidaTag[] = [];
  today: TodaySnapshot | null = null;
  overview: OverviewSnapshot | null = null;
  lastRefreshAt = 0;

  private projectsLoadedAt = 0;
  private tagsLoadedAt = 0;
  private readonly projectCache = new Map<string, ProjectSnapshot>();
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** 刚建的任务：滴答的读接口会滞后几秒，重新拉取时没返回的先补回去，见到了就移除。 */
  private readonly pendingCreated = new Map<string, { task: DidaTask; at: number }>();
  /** 不在未完成缓存里的子任务查过之后的状态；没查过的不在表里 */
  private readonly childState = new Map<string, "done" | "gone" | "open">();
  private readonly childFetching = new Set<string>();

  private readonly api: DidaApi;
  private readonly options: StoreOptions;

  constructor(api: DidaApi, options: StoreOptions) {
    this.api = api;
    this.options = options;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** 同一个 key 的请求并发时只发一次。 */
  private dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  projectKey(id: string): string {
    return isInboxId(id) ? INBOX_ID : id;
  }

  projectById(id: string | null | undefined): DidaProject | null {
    if (!id) return null;
    if (isInboxId(id)) return this.projects.find((p) => p.id === INBOX_ID) ?? INBOX_PROJECT;
    return this.projects.find((p) => p.id === id) ?? null;
  }

  projectName(id: string | null | undefined): string {
    return this.projectById(id)?.name ?? "未知项目";
  }

  groupName(groupId: string | null): string | null {
    if (!groupId) return null;
    return this.groups.find((g) => g.id === groupId)?.name ?? null;
  }

  tagByName(name: string): DidaTag | null {
    const lower = name.toLowerCase();
    return this.tags.find((t) => t.name === lower || t.name === name || t.label === name) ?? null;
  }

  async loadProjects(force = false): Promise<DidaProject[]> {
    if (!force && this.projects.length && Date.now() - this.projectsLoadedAt < 10 * 60_000) return this.projects;
    return this.dedupe("projects", async () => {
      const [projects, groups] = await Promise.all([
        this.api.listProjects(),
        this.api.listProjectGroups().catch(() => [] as DidaProjectGroup[])
      ]);
      const active = projects.filter((p) => p.closed !== true);
      const visible = this.options.hideSeparators() ? active.filter((p) => !isSeparatorProject(p.name)) : active;
      const withInbox = visible.some((p) => p.id === INBOX_ID) ? visible : [INBOX_PROJECT, ...visible];
      this.projects = [INBOX_PROJECT, ...withInbox.filter((p) => p.id !== INBOX_ID)];
      this.groups = groups;
      this.projectsLoadedAt = Date.now();
      this.lastRefreshAt = Date.now();
      this.emit();
      return this.projects;
    });
  }

  async loadTags(force = false): Promise<DidaTag[]> {
    if (!force && this.tags.length && Date.now() - this.tagsLoadedAt < 10 * 60_000) return this.tags;
    return this.dedupe("tags", async () => {
      this.tags = await this.api.listTags();
      this.tagsLoadedAt = Date.now();
      this.emit();
      return this.tags;
    });
  }

  getProject(id: string): ProjectSnapshot | null {
    return this.projectCache.get(this.projectKey(id)) ?? null;
  }

  async loadProject(id: string, force = false): Promise<ProjectSnapshot> {
    const key = this.projectKey(id);
    const cached = this.projectCache.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < 60_000) return cached;
    return this.dedupe(`project:${key}`, async () => {
      const now = new Date();
      const [bundle, done] = await Promise.all([
        this.api.getProjectWithTasks(key),
        this.options.showCompleted()
          ? this.api.listCompletedTasks(addDays(startOfDay(now), -30), addDays(startOfDay(now), 1), [key]).catch(() => [] as DidaTask[])
          : Promise.resolve([] as DidaTask[])
      ]);
      const completed = done
        .filter((t) => this.projectKey(t.projectId) === key)
        .sort((a, b) => (b.completedTime ?? "").localeCompare(a.completedTime ?? ""));
      const snapshot: ProjectSnapshot = { ...bundle, tasks: this.withPending(bundle.tasks, (t) => this.projectKey(t.projectId) === key), completed, fetchedAt: Date.now() };
      if (key === INBOX_ID) snapshot.project = { ...snapshot.project, id: INBOX_ID, name: "收件箱" };
      const prev = this.projectCache.get(key);
      this.projectCache.set(key, snapshot);
      this.lastRefreshAt = Date.now();
      // 后台对账拉回来的和手上一样就不重画，免得面板闪一下
      if (!prev || !sameData([prev.project, prev.columns, prev.tasks, prev.completed], [snapshot.project, snapshot.columns, snapshot.tasks, snapshot.completed])) this.emit();
      return snapshot;
    });
  }

  async loadToday(force = false): Promise<TodaySnapshot> {
    if (!force && this.today && Date.now() - this.today.fetchedAt < 60_000) return this.today;
    return this.dedupe("today", async () => {
      const now = new Date();
      const range = this.options.completedRange();
      const completedFrom = range === "today" ? startOfDay(now) : range === "week" ? addDays(startOfDay(now), -7) : null;
      const [today, overdue, completed] = await Promise.all([
        this.api.listTodayTasks(),
        this.api.listOverdueTasks(now).catch(() => [] as DidaTask[]),
        completedFrom ? this.api.listCompletedTasks(completedFrom, addDays(startOfDay(now), 1)).catch(() => [] as DidaTask[]) : Promise.resolve([] as DidaTask[])
      ]);
      const todayIds = new Set(today.map((t) => t.id));
      const prev = this.today;
      this.today = {
        today: this.withPending(today, (t) => describeDue(t).state === "today"),
        overdue: overdue.filter((t) => !todayIds.has(t.id)),
        completed,
        fetchedAt: Date.now()
      };
      this.lastRefreshAt = Date.now();
      if (!prev || !sameData([prev.today, prev.overdue, prev.completed], [this.today.today, this.today.overdue, this.today.completed])) this.emit();
      return this.today;
    });
  }

  /** 项目总览：每个项目的未完成数与过期数，来自一次全量 filter_tasks。 */
  async loadOverview(force = false): Promise<OverviewSnapshot> {
    if (!force && this.overview && Date.now() - this.overview.fetchedAt < 60_000) return this.overview;
    return this.dedupe("overview", async () => {
      const tasks = this.withPending(await this.api.listAllUndoneTasks(), () => true);
      const todayStart = startOfDay(new Date()).getTime();
      const counts = new Map<string, ProjectCount>();
      let totalOverdue = 0;
      for (const t of tasks) {
        const key = this.projectKey(t.projectId);
        const entry = counts.get(key) ?? { undone: 0, overdue: 0 };
        entry.undone += 1;
        const due = t.dueDate ?? t.startDate;
        if (due) {
          const d = new Date(due).getTime();
          if (!Number.isNaN(d) && d < todayStart) {
            entry.overdue += 1;
            totalOverdue += 1;
          }
        }
        counts.set(key, entry);
      }
      this.overview = { counts, tasks, totalUndone: tasks.length, totalOverdue, fetchedAt: Date.now() };
      this.lastRefreshAt = Date.now();
      this.emit();
      return this.overview;
    });
  }

  invalidateAll(): void {
    this.projectCache.clear();
    this.today = null;
    this.overview = null;
    this.projectsLoadedAt = 0;
    this.tagsLoadedAt = 0;
    this.emit();
  }


  private removeLocally(taskId: string): void {
    this.pendingCreated.delete(taskId);
    for (const snap of this.projectCache.values()) snap.tasks = snap.tasks.filter((t) => t.id !== taskId);
    if (this.today) {
      this.today = {
        ...this.today,
        today: this.today.today.filter((t) => t.id !== taskId),
        overdue: this.today.overdue.filter((t) => t.id !== taskId)
      };
    }
  }

  /** 刚建好的任务先放进手上的缓存，不等重拉就能看到。 */
  private insertLocally(task: DidaTask): void {
    const has = (list: DidaTask[]): boolean => list.some((t) => t.id === task.id);
    const snap = this.projectCache.get(this.projectKey(task.projectId));
    if (snap && !has(snap.tasks)) snap.tasks = [...snap.tasks, task];
    if (this.today && describeDue(task).state === "today" && !has(this.today.today)) this.today = { ...this.today, today: [...this.today.today, task] };
    if (this.overview && !has(this.overview.tasks)) this.overview = { ...this.overview, tasks: [...this.overview.tasks, task] };
  }

  private replaceLocally(task: DidaTask): void {
    if (this.pendingCreated.has(task.id)) this.pendingCreated.set(task.id, { task, at: Date.now() });
    const swap = (list: DidaTask[]): DidaTask[] => list.map((t) => (t.id === task.id ? task : t));
    for (const snap of this.projectCache.values()) snap.tasks = swap(snap.tasks);
    if (this.today) {
      this.today = { ...this.today, today: swap(this.today.today), overdue: swap(this.today.overdue) };
    }
    if (this.overview) this.overview = { ...this.overview, tasks: swap(this.overview.tasks) };
  }

  /**
   * 子任务进度。滴答删掉子任务后，父任务的 childIds 里还留着它的 id（2026-10-28 用真实数据确认：
   * id 还在，按 id 去取返回 task not found），所以不能直接拿 childIds 的长度当总数。
   * 未完成的从缓存里数；缓存里没有的 id 在后台逐个查一次，记下是已完成、已删除还是在别处未完成，查到后重画。
   */
  subtaskProgress(task: DidaTask): { done: number; total: number } {
    const open = this.childrenOf(task.id);
    const openIds = new Set(open.map((t) => t.id));
    let done = 0;
    let total = open.length;
    const unknown: string[] = [];
    for (const id of task.childIds ?? []) {
      if (openIds.has(id)) continue;
      const state = this.childState.get(id);
      if (state === "done") {
        done += 1;
        total += 1;
      } else if (state === "open") total += 1;
      else if (state === undefined) unknown.push(id);
    }
    if (unknown.length) void this.resolveChildren(task.id, unknown);
    return { done, total };
  }

  private async resolveChildren(parentId: string, ids: string[]): Promise<void> {
    const todo = ids.filter((id) => !this.childFetching.has(id));
    if (!todo.length) return;
    for (const id of todo) this.childFetching.add(id);
    await Promise.all(
      todo.map(async (id) => {
        try {
          const t = await this.api.getTask(id);
          // 挂到别的父任务下、或已经转成独立任务的，也不再算这个父任务的
          this.childState.set(id, t.parentId !== parentId ? "gone" : t.status === 2 ? "done" : "open");
        } catch (error) {
          if (/not[_ ]found|没有找到/i.test(error instanceof Error ? error.message : String(error))) this.childState.set(id, "gone");
        } finally {
          this.childFetching.delete(id);
        }
      })
    );
    this.emit();
  }

  /** 某条任务未完成的子任务，从各处缓存（含刚建还没读到的）里收集、去重。 */
  childrenOf(taskId: string): DidaTask[] {
    const seen = new Map<string, DidaTask>();
    const pools = [
      ...Array.from(this.projectCache.values()).map((s) => s.tasks),
      this.today?.today ?? [],
      this.today?.overdue ?? [],
      this.overview?.tasks ?? [],
      Array.from(this.pendingCreated.values()).map((e) => e.task)
    ];
    for (const list of pools) for (const t of list) if (t.parentId === taskId && t.status !== 2 && !seen.has(t.id)) seen.set(t.id, t);
    return [...seen.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  /** 从所有缓存里按 id 找任务标题（给确认框用）。 */
  taskTitle(taskId: string): string | null {
    for (const snap of this.projectCache.values()) {
      const hit = snap.tasks.find((t) => t.id === taskId);
      if (hit) return hit.title;
    }
    for (const list of [this.overview?.tasks ?? [], this.today?.today ?? [], this.today?.overdue ?? []]) {
      const hit = list.find((t) => t.id === taskId);
      if (hit) return hit.title;
    }
    return null;
  }

  /** 打了队列标签的未完成任务（来自总览快照）。 */
  queuedTasks(tag: string): DidaTask[] {
    return (this.overview?.tasks ?? []).filter((t) => (t.tags ?? []).includes(tag));
  }

  /**
   * 变更后在后台重新拉受影响的数据。旧数据留着照常显示，拉回来有变化才重画；
   * 先清缓存再拉的话，中间那一下面板是空的，看起来像整页刷新。
   */
  private reloadAffected(projectIds: Array<string | null | undefined>): void {
    // 总览是一次全量查询，不在这里跟着拉，只标成过期，下次打开总览时重拉
    if (this.overview) this.overview = { ...this.overview, fetchedAt: 0 };
    void Promise.all([
      ...projectIds.filter((id): id is string => !!id).map((id) => this.loadProject(id, true).catch(() => null)),
      // 今天没打开过就不拉，等切到今天时再拉
      this.today ? this.loadToday(true).catch(() => null) : null
    ]);
  }

  async createTask(input: TaskInput): Promise<DidaTask> {
    const created = await this.api.createTask(input);
    const task: DidaTask = { ...created, columnId: created.columnId ?? input.columnId ?? null };
    this.pendingCreated.set(task.id, { task, at: Date.now() });
    this.insertLocally(task);
    this.emit();
    this.reloadAffected([input.projectId]);
    // 第一次重拉多半还读不到新任务，过几秒再对一次账
    setTimeout(() => this.reloadAffected([input.projectId]), 4000);
    return task;
  }

  private withPending(fresh: DidaTask[], belongs: (task: DidaTask) => boolean): DidaTask[] {
    const now = Date.now();
    const ids = new Set(fresh.map((t) => t.id));
    const extra: DidaTask[] = [];
    for (const [id, entry] of this.pendingCreated) {
      if (now - entry.at > PENDING_TTL) this.pendingCreated.delete(id);
      else if (!ids.has(id) && belongs(entry.task)) extra.push(entry.task);
    }
    return extra.length ? [...fresh, ...extra] : fresh;
  }

  async updateTask(task: DidaTask, patch: Partial<TaskInput> & { status?: DidaTask["status"] }): Promise<DidaTask> {
    const updated = await this.api.updateTask(task, patch);
    this.replaceLocally(updated);
    this.emit();
    this.reloadAffected([task.projectId, patch.projectId]);
    return updated;
  }

  async completeTask(task: DidaTask): Promise<void> {
    if (task.parentId) this.childState.set(task.id, "done");
    this.removeLocally(task.id);
    const snap = this.projectCache.get(this.projectKey(task.projectId));
    if (snap && this.options.showCompleted()) snap.completed = [{ ...task, status: 2, completedTime: new Date().toISOString() }, ...snap.completed];
    this.emit();
    try {
      await this.api.completeTask(task);
    } finally {
      this.reloadAffected([task.projectId]);
    }
  }

  async deleteTask(task: DidaTask): Promise<void> {
    if (task.parentId) this.childState.set(task.id, "gone");
    this.removeLocally(task.id);
    this.emit();
    try {
      await this.api.deleteTask(task);
    } finally {
      this.reloadAffected([task.projectId]);
    }
  }

  /** 收件箱的真实 id（inbox 加用户号），从缓存里任意一条收件箱任务上取。 */
  private realInboxId(): string | null {
    const pools = [...Array.from(this.projectCache.values()).map((s) => s.tasks), this.overview?.tasks ?? [], this.today?.today ?? [], this.today?.overdue ?? []];
    for (const list of pools) {
      const hit = list.find((t) => isInboxId(t.projectId) && t.projectId !== INBOX_ID);
      if (hit) return hit.projectId;
    }
    return null;
  }

  /** 新建项目：先插进本地列表（排在同文件夹最后），再从滴答拉一次项目列表。 */
  async createProject(input: ProjectInput & { name: string }): Promise<DidaProject> {
    const project = await this.api.createProject(input);
    if (!this.projects.some((p) => p.id === project.id)) this.projects = [...this.projects, project];
    this.emit();
    setTimeout(() => void this.loadProjects(true).catch(() => null), 4000);
    return project;
  }

  /** 改项目（名称、颜色、视图、文件夹，或 closed=true 归档）。归档的项目立刻从列表里拿掉。 */
  async updateProject(projectId: string, patch: ProjectInput): Promise<void> {
    const updated = await this.api.updateProject(projectId, patch);
    if (patch.closed) {
      this.projects = this.projects.filter((p) => p.id !== projectId);
      this.projectCache.delete(this.projectKey(projectId));
      this.overview = null;
    } else {
      this.projects = this.projects.map((p) => (p.id === projectId ? { ...p, ...stripUndefined(patch), ...(updated ?? {}), id: p.id } : p));
      const snap = this.projectCache.get(this.projectKey(projectId));
      if (snap) snap.project = this.projects.find((p) => p.id === projectId) ?? snap.project;
    }
    this.emit();
    setTimeout(() => void this.loadProjects(true).catch(() => null), 4000);
  }

  // ---------- 项目文件夹 ----------

  async createGroup(name: string): Promise<DidaProjectGroup> {
    const group = await this.api.createProjectGroup(name);
    this.groups = [...this.groups.filter((g) => g.id !== group.id), group];
    this.emit();
    return group;
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    await this.api.renameProjectGroup(groupId, name);
    this.groups = this.groups.map((g) => (g.id === groupId ? { ...g, name } : g));
    this.emit();
  }

  /** 删文件夹，里面的项目留着、改成不在文件夹里 */
  async deleteGroup(groupId: string): Promise<void> {
    await this.api.deleteProjectGroup(groupId);
    this.groups = this.groups.filter((g) => g.id !== groupId);
    this.projects = this.projects.map((p) => (p.groupId === groupId ? { ...p, groupId: null } : p));
    this.emit();
    setTimeout(() => void this.loadProjects(true).catch(() => null), 4000);
  }

  // ---------- 标签 ----------

  /** 标签改名、删除会改到所有带这个标签的任务，手上的任务缓存全部作废重拉 */
  async renameTag(name: string, newName: string): Promise<void> {
    await this.api.renameTag(name, newName);
    await this.afterTagChange();
  }

  async deleteTag(name: string): Promise<void> {
    await this.api.deleteTag(name);
    await this.afterTagChange();
  }

  private async afterTagChange(): Promise<void> {
    const projectIds = Array.from(this.projectCache.keys());
    this.tagsLoadedAt = 0;
    await this.loadTags(true).catch(() => null);
    this.reloadAffected(projectIds);
  }

  // ---------- 批量 ----------

  /** 多条一起改：先在本地套上改动立刻显示，再一次提交给滴答，最后重拉涉及的项目 */
  async batchUpdate(tasks: DidaTask[], patchOf: (task: DidaTask) => Partial<TaskInput>): Promise<void> {
    if (!tasks.length) return;
    const updates = tasks.map((task) => ({ task, patch: patchOf(task) }));
    for (const { task, patch } of updates) this.replaceLocally({ ...task, ...stripUndefined(patch), etag: null } as DidaTask);
    this.emit();
    try {
      await this.api.batchUpdateTasks(updates);
    } finally {
      this.reloadAffected([...new Set(tasks.map((t) => t.projectId))]);
    }
  }

  /**
   * 新建分组。不给位置就排在最后；给了 before / after 就插在那个分组的左边 / 右边（取两侧排序值的中点）。
   * 先插进本地缓存，几秒后再从滴答对一次账（读接口会滞后）。
   */
  async createColumn(projectId: string, name: string, at: { before?: string; after?: string } = {}): Promise<DidaColumn> {
    const key = this.projectKey(projectId);
    const target = key === INBOX_ID ? (this.realInboxId() ?? key) : key;
    const columns = [...(this.projectCache.get(key)?.columns ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    const column = await this.api.createColumn(target, name, columnSortOrder(columns, at));
    const snap = this.projectCache.get(key);
    if (snap && !snap.columns.some((c) => c.id === column.id)) snap.columns = [...snap.columns, column].sort((a, b) => a.sortOrder - b.sortOrder);
    this.emit();
    setTimeout(() => void this.loadProject(key, true).catch(() => null), 4000);
    return column;
  }

  async renameColumn(projectId: string, column: DidaColumn, name: string): Promise<void> {
    const key = this.projectKey(projectId);
    await this.api.updateColumn(this.columnTarget(key), column.id, { name });
    const snap = this.projectCache.get(key);
    if (snap) snap.columns = snap.columns.map((c) => (c.id === column.id ? { ...c, name } : c));
    this.emit();
  }

  /** 分组左移 / 右移一位：和相邻分组交换排序值。 */
  async moveColumn(projectId: string, column: DidaColumn, step: -1 | 1): Promise<void> {
    const key = this.projectKey(projectId);
    const snap = this.projectCache.get(key);
    if (!snap) return;
    const columns = [...snap.columns].sort((a, b) => a.sortOrder - b.sortOrder);
    const i = columns.findIndex((c) => c.id === column.id);
    const other = columns[i + step];
    if (i < 0 || !other) return;
    const target = this.columnTarget(key);
    await Promise.all([
      this.api.updateColumn(target, column.id, { sortOrder: other.sortOrder }),
      this.api.updateColumn(target, other.id, { sortOrder: column.sortOrder })
    ]);
    snap.columns = snap.columns
      .map((c) => (c.id === column.id ? { ...c, sortOrder: other.sortOrder } : c.id === other.id ? { ...c, sortOrder: column.sortOrder } : c))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    this.emit();
  }

  private columnTarget(key: string): string {
    return key === INBOX_ID ? (this.realInboxId() ?? key) : key;
  }

  async moveTask(task: DidaTask, toProjectId: string): Promise<void> {
    const target = toProjectId === INBOX_ID ? (this.realInboxId() ?? toProjectId) : toProjectId;
    this.removeLocally(task.id);
    this.emit();
    try {
      await this.api.moveTask(task, target);
    } finally {
      this.reloadAffected([task.projectId, toProjectId]);
    }
  }
}
