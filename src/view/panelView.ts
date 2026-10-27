import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import type { PanelTab, ProjectViewMode } from "../settings.ts";
import { CLEAR_DATE, addDays, describeDue, formatDidaDate, relativeTime, startOfDay } from "../dida/dates.ts";
import { firstLinkedPath } from "../dida/deeplink.ts";
import { parseQuickAdd } from "../dida/quickAdd.ts";
import { INBOX_ID, PRIORITIES, PRIORITY_LABEL, type DidaColumn, type DidaProject, type DidaTask, type TaskInput, type TaskSearchHit } from "../dida/types.ts";
import { McpAuthError } from "../mcp/client.ts";
import { isQueued } from "../dispatch/prompt.ts";
import type { ProjectSnapshot } from "../store.ts";
import { ConfirmModal } from "./confirm.ts";
import { ProjectSuggestModal } from "./projectSuggest.ts";
import { ChatDock } from "./chatDock.ts";
import type { PromptContext } from "../agent/systemPrompt.ts";

export const VIEW_TYPE_DIDA = "todaylab-dida-panel";

export interface PanelViewState {
  tab?: PanelTab;
  projectId?: string | null;
  mode?: ProjectViewMode;
}

interface TaskRenderContext {
  /** 今天视图里写项目名；项目视图里不写（标题已经说明了）。 */
  showProject: boolean;
  /** 今天分组里不再写「今天」两个字，只在有时间点时写时间。 */
  hideTodayLabel?: boolean;
  columns?: DidaColumn[];
  /** 看板卡片：常驻卡片底，可拖拽。 */
  card?: boolean;
  /** 不显示这个标签（队列视图里「派给AI」是前提，不用再写） */
  hideTag?: string;
}

export function taskWebUrl(task: DidaTask): string {
  return `https://dida365.com/webapp/#p/${task.projectId}/tasks/${task.id}`;
}

function stripDecor(name: string): string {
  return name.replace(/[\p{Extended_Pictographic}️\s]/gu, "").toLowerCase();
}

export class DidaPanelView extends ItemView {
  private tab: PanelTab;
  /** null = 项目总览 */
  private projectId: string | null = null;
  /** 项目页签下的跨项目「AI 队列」视图 */
  private queueMode = false;
  private filterTag: string | null = null;
  private searchQuery = "";
  private searchHits: TaskSearchHit[] = [];
  private searching = false;
  private readonly collapsed = new Set<string>(["completed"]);
  private expanded: string | null = null;
  private loading = false;
  private error: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private listEl: HTMLElement | null = null;
  private quickValue = "";
  private quickFocused = false;
  private dragging: DidaTask | null = null;
  private mainEl: HTMLElement | null = null;
  private dock: ChatDock | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: DidaPanelPlugin) {
    super(leaf);
    this.tab = plugin.settings.defaultView;
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE_DIDA;
  }

  getDisplayText(): string {
    if (this.tab === "project" && this.projectId) return `滴答清单 · ${this.plugin.store.projectName(this.projectId)}`;
    return "滴答清单";
  }

  getIcon(): string {
    return "check-circle";
  }

  getState(): Record<string, unknown> {
    return { tab: this.tab, projectId: this.projectId, mode: this.projectId ? this.modeFor(this.projectId) : undefined };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as PanelViewState;
    if (s.tab) this.tab = s.tab;
    if (s.projectId !== undefined) this.projectId = s.projectId;
    if (s.projectId && s.mode) this.setMode(s.projectId, s.mode, false);
    await super.setState(state, result);
    void this.refresh(false);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("dida-host");
    this.mainEl = this.contentEl.createDiv({ cls: "dida-panel" });
    const dockHost = this.contentEl.createDiv();
    this.dock = new ChatDock(
      this.plugin,
      dockHost,
      this,
      () => this.promptContext(),
      () => {
        this.plugin.store.invalidateAll();
        void this.refresh(true);
      }
    );
    this.dock.render();
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
    await this.refresh(false);
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dock?.destroy();
    this.dock = null;
  }

  /** 给底部对话框的系统提示用的当前上下文。 */
  private promptContext(): PromptContext {
    const store = this.plugin.store;
    const now = new Date();
    const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const projectId = this.tab === "inbox" ? INBOX_ID : this.tab === "project" ? this.projectId : null;
    const snap = projectId ? store.getProject(projectId) : null;
    const project = projectId ? (store.projectById(projectId) ?? snap?.project ?? null) : null;
    const tabName = this.tab === "today" ? "今天" : this.tab === "inbox" ? "收件箱" : this.tab === "search" ? "搜索" : this.queueMode ? "AI 队列" : this.projectId ? "项目详情" : "项目总览";
    const expandedTask = this.expanded ? { id: this.expanded, title: store.taskTitle(this.expanded) ?? "" } : null;
    return {
      today,
      weekday,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      vaultName: this.plugin.settings.vaultName || this.app.vault.getName(),
      currentNotePath: this.app.workspace.getActiveFile()?.path ?? null,
      tab: tabName,
      project: project
        ? {
            id: projectId === INBOX_ID ? (snap?.tasks[0]?.projectId ?? INBOX_ID) : project.id,
            name: project.name,
            viewMode: project.viewMode,
            columns: (snap?.columns ?? []).map((c) => ({ id: c.id, name: c.name }))
          }
        : null,
      expandedTask: expandedTask?.title ? expandedTask : null,
      queueTag: this.plugin.settings.aiTag
    };
  }

  // ---------- 状态切换 ----------

  setTab(tab: PanelTab): void {
    if (this.tab === tab) {
      // 再点一次「项目」回到总览
      if (tab === "project" && (this.projectId || this.queueMode)) {
        this.projectId = null;
        this.queueMode = false;
        void this.refresh(false);
      }
      return;
    }
    this.tab = tab;
    this.error = null;
    this.expanded = null;
    void this.refresh(false);
  }

  showQueue(): void {
    this.tab = "project";
    this.projectId = null;
    this.queueMode = true;
    this.expanded = null;
    void this.refresh(false);
  }

  showProject(id: string): void {
    this.tab = "project";
    this.projectId = id;
    this.queueMode = false;
    this.filterTag = null;
    this.expanded = null;
    this.plugin.settings.lastProjectId = id;
    void this.plugin.saveSettings();
    void this.refresh(false);
  }

  showOverview(): void {
    this.tab = "project";
    this.projectId = null;
    this.queueMode = false;
    this.filterTag = null;
    this.expanded = null;
    void this.refresh(false);
  }

  modeFor(projectId: string): ProjectViewMode {
    return this.plugin.settings.viewModes[this.plugin.store.projectKey(projectId)] ?? "list";
  }

  setMode(projectId: string, mode: ProjectViewMode, rerender = true): void {
    this.plugin.settings.viewModes[this.plugin.store.projectKey(projectId)] = mode;
    void this.plugin.saveSettings();
    if (rerender) this.render();
  }

  async refresh(force: boolean): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      await this.plugin.store.loadProjects(force);
      void this.plugin.store.loadTags().catch(() => null);
      if (this.tab === "today") await this.plugin.store.loadToday(force);
      else if (this.tab === "inbox") await this.plugin.store.loadProject(INBOX_ID, force);
      else if (this.tab === "project") {
        if (this.projectId && !this.plugin.store.projectById(this.projectId)) this.projectId = null;
        if (this.projectId) await this.plugin.store.loadProject(this.projectId, force);
        else await this.plugin.store.loadOverview(force || this.queueMode);
      } else if (this.tab === "search" && this.searchQuery) await this.runSearch();
      if (this.tab !== "inbox" && !this.plugin.store.getProject(INBOX_ID)) void this.plugin.store.loadProject(INBOX_ID).catch(() => null);
    } catch (error) {
      this.error = error;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async runSearch(): Promise<void> {
    const q = this.searchQuery.trim();
    if (!q) {
      this.searchHits = [];
      return;
    }
    this.searching = true;
    this.render();
    try {
      this.searchHits = await this.plugin.api.searchTasks(q);
    } finally {
      this.searching = false;
    }
  }

  private currentProjectId(): string {
    if (this.tab === "inbox") return INBOX_ID;
    if (this.tab === "project" && this.projectId) return this.projectId;
    return this.plugin.settings.defaultProjectId || INBOX_ID;
  }

  // ---------- 渲染 ----------

  render(): void {
    const root = this.mainEl ?? this.contentEl;
    const prevScroll = this.listEl?.scrollTop ?? 0;
    const prevScrollLeft = this.listEl?.scrollLeft ?? 0;
    const active = document.activeElement;
    this.quickFocused = active instanceof HTMLInputElement && active.hasClass("dida-quick-input");
    if (this.quickFocused && active instanceof HTMLInputElement) this.quickValue = active.value;

    root.empty();
    root.addClass("dida-panel");
    this.renderHeader(root);
    this.renderTabs(root);

    const inProject = this.tab === "project" && !!this.projectId;
    const inQueue = this.tab === "project" && !this.projectId && this.queueMode;
    const snap = inProject ? this.plugin.store.getProject(this.projectId ?? "") : null;
    const boardMode = inProject && !!snap?.columns.length && this.modeFor(this.projectId ?? "") === "board";
    if (inProject) this.renderProjectHead(root, this.projectId ?? "", snap, boardMode);
    if (inQueue) this.renderQueueHead(root);
    if (this.tab === "search") this.renderSearchBox(root);
    else if (!(this.tab === "project" && !this.projectId)) this.renderQuickAdd(root);

    const body = root.createDiv({ cls: "dida-body" });
    if (boardMode) body.addClass("is-board");
    this.listEl = body;
    if (this.error) this.renderError(body);
    else if (this.tab === "today") this.renderToday(body);
    else if (this.tab === "inbox") this.renderProjectBody(body, INBOX_ID, false);
    else if (this.tab === "project") {
      if (inQueue) this.renderQueue(body);
      else if (!this.projectId) this.renderOverview(body);
      else this.renderProjectBody(body, this.projectId, boardMode);
    } else this.renderSearchResults(body);

    if (this.loading && body.childElementCount === 0) body.createDiv({ cls: "dida-loading", text: "加载中…" });
    body.scrollTop = prevScroll;
    body.scrollLeft = prevScrollLeft;
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "dida-header" });
    header.createSpan({ cls: "dida-header-title", text: "滴答清单" });
    const synced = this.plugin.store.lastRefreshAt ? `${relativeTime(this.plugin.store.lastRefreshAt)}同步，点击立即同步` : "立即同步";
    this.iconButton(header, "refresh-cw", synced, () => void this.refresh(true), this.loading ? "is-loading" : "");
    this.iconButton(header, "plus", "新建待办", () => this.openCreate(), "is-accent");
    this.iconButton(header, "more-horizontal", "更多", (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("插件设置").setIcon("settings").onClick(() => this.plugin.openSettings()));
      menu.addItem((i) => i.setTitle("在滴答清单网页版打开").setIcon("external-link").onClick(() => window.open("https://dida365.com/webapp/")));
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(this.plugin.isLoggedIn() ? "重新登录" : "登录滴答清单")
          .setIcon("log-in")
          .onClick(() => void this.plugin.login().then(() => this.refresh(true)))
      );
      menu.showAtMouseEvent(e);
    });
  }

  private renderTabs(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: "dida-tabs" });
    const inboxCount = this.plugin.store.getProject(INBOX_ID)?.tasks.length;
    const defs: Array<[PanelTab, string, number | undefined]> = [
      ["today", "今天", undefined],
      ["inbox", "收件箱", inboxCount],
      ["project", "项目", undefined],
      ["search", "搜索", undefined]
    ];
    for (const [tab, label, count] of defs) {
      const btn = tabs.createEl("button", { cls: "dida-tab", text: label, attr: { type: "button" } });
      if (count !== undefined && count > 0) btn.createSpan({ cls: "dida-tab-count", text: String(count) });
      btn.toggleClass("is-active", this.tab === tab);
      btn.addEventListener("click", () => this.setTab(tab));
    }
  }

  /** 项目详情头部：返回 · 项目名与数字 · 列表/看板 · 更多 */
  private renderProjectHead(root: HTMLElement, projectId: string, snap: ProjectSnapshot | null, boardMode: boolean): void {
    const store = this.plugin.store;
    const project = store.projectById(projectId) ?? snap?.project ?? null;
    const head = root.createDiv({ cls: "dida-project-head" });
    this.iconButton(head, "chevron-left", "返回项目总览", () => this.showOverview());

    const text = head.createDiv({ cls: "dida-project-head-text" });
    text.createSpan({ cls: "dida-project-head-name", text: project?.name ?? "项目" });
    const parts: string[] = [];
    if (snap) {
      parts.push(`${snap.tasks.length} 待办`);
      const overdue = snap.tasks.filter((t) => describeDue(t).state === "overdue").length;
      if (overdue) parts.push(`${overdue} 过期`);
    }
    const group = store.groupName(project?.groupId ?? null);
    if (group) parts.unshift(group);
    if (parts.length) text.createSpan({ cls: "dida-project-head-sub", text: parts.join(" · ") });

    if (snap?.columns.length) {
      const seg = head.createDiv({ cls: "dida-seg", attr: { role: "group", "aria-label": "显示方式" } });
      const list = seg.createEl("button", { text: "列表", attr: { type: "button" } });
      const board = seg.createEl("button", { text: "看板", attr: { type: "button" } });
      list.toggleClass("is-on", !boardMode);
      board.toggleClass("is-on", boardMode);
      list.addEventListener("click", () => this.setMode(projectId, "list"));
      board.addEventListener("click", () => this.setMode(projectId, "board"));
    }

    this.iconButton(head, "more-horizontal", "项目更多操作", (e) => {
      const menu = new Menu();
      if (snap?.columns.length) {
        menu.addItem((i) => i.setTitle("在主窗格打开看板").setIcon("layout-dashboard").onClick(() => void this.plugin.openBoardInMainPane(projectId)));
      }
      menu.addItem((i) => i.setTitle("切换到其他项目…").setIcon("folder").onClick(() => new ProjectSuggestModal(this.app, store, (p) => this.showProject(p.id)).open()));
      menu.addItem((i) => i.setTitle("刷新此项目").setIcon("refresh-cw").onClick(() => void this.refresh(true)));
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("在滴答清单网页版打开").setIcon("external-link").onClick(() => {
          const id = projectId === INBOX_ID ? (snap?.tasks[0]?.projectId ?? "inbox") : projectId;
          window.open(`https://dida365.com/webapp/#p/${id}/tasks`);
        })
      );
      menu.showAtMouseEvent(e);
    });

    if (!snap) return;
    const tagsInUse = Array.from(new Set(snap.tasks.flatMap((t) => t.tags ?? []))).sort();
    if (!tagsInUse.length) return;
    const filter = root.createDiv({ cls: "dida-filter" });
    for (const tag of tagsInUse) {
      const btn = filter.createEl("button", { cls: "dida-ftag", text: this.plugin.tagLabel(tag), attr: { type: "button" } });
      btn.toggleClass("is-active", this.filterTag === tag);
      btn.addEventListener("click", () => {
        this.filterTag = this.filterTag === tag ? null : tag;
        this.render();
      });
    }
  }

  private renderQuickAdd(root: HTMLElement): void {
    const wrap = root.createDiv({ cls: "dida-quick" });
    const icon = wrap.createSpan();
    setIcon(icon, "plus");
    const input = wrap.createEl("input", { type: "text", cls: "dida-quick-input", attr: { "aria-label": "快速添加待办" } });
    input.placeholder = `添加待办到「${this.plugin.store.projectName(this.currentProjectId())}」`;
    input.value = this.quickValue;
    input.addEventListener("input", () => (this.quickValue = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.quickAdd(input);
      }
    });
    root.createDiv({ cls: "dida-quick-hint", text: "明天 14:00 · !高 · #标签 · ^项目" });
    if (this.quickFocused) {
      window.setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 0);
    }
  }

  private async quickAdd(input: HTMLInputElement): Promise<void> {
    const parsed = parseQuickAdd(input.value);
    if (!parsed.title) {
      new Notice("先写点内容");
      return;
    }
    let projectId = this.currentProjectId();
    if (parsed.projectQuery) {
      const q = stripDecor(parsed.projectQuery);
      const hit = this.plugin.store.projects.find((p) => stripDecor(p.name) === q) ?? this.plugin.store.projects.find((p) => stripDecor(p.name).includes(q));
      if (!hit) {
        new Notice(`没有找到项目「${parsed.projectQuery}」`);
        return;
      }
      projectId = hit.id;
    }
    const taskInput: TaskInput = {
      title: parsed.title,
      projectId,
      priority: parsed.priority ?? 0,
      tags: parsed.tags,
      content: ""
    };
    const snap = this.plugin.store.getProject(projectId);
    if (snap?.columns.length) taskInput.columnId = snap.columns[0].id;
    if (parsed.date) {
      const when = formatDidaDate(parsed.date, parsed.allDay);
      taskInput.startDate = when;
      taskInput.dueDate = when;
      taskInput.isAllDay = parsed.allDay;
    }
    const note = this.plugin.settings.attachNoteLink ? this.plugin.currentNote() : null;
    if (note) taskInput.content = this.plugin.noteLinkContent(note);
    input.disabled = true;
    try {
      await this.plugin.store.createTask(taskInput);
      this.quickValue = "";
      new Notice(`已添加到「${this.plugin.store.projectName(projectId)}」`);
    } catch (error) {
      new Notice(`添加失败：${this.plugin.describeError(error)}`, 6000);
    } finally {
      input.disabled = false;
      this.render();
    }
  }

  private renderSearchBox(root: HTMLElement): void {
    const wrap = root.createDiv({ cls: "dida-quick" });
    const icon = wrap.createSpan();
    setIcon(icon, "search");
    const input = wrap.createEl("input", { type: "search", cls: "dida-quick-input", attr: { "aria-label": "搜索待办" } });
    input.placeholder = "搜索所有待办";
    input.value = this.searchQuery;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.searchQuery = input.value;
        void this.runSearch()
          .catch((error: unknown) => (this.error = error))
          .finally(() => this.render());
      }
    });
    if (!this.searchQuery) window.setTimeout(() => input.focus(), 0);
  }

  private renderSearchResults(body: HTMLElement): void {
    if (this.searching) {
      body.createDiv({ cls: "dida-loading", text: "搜索中…" });
      return;
    }
    if (!this.searchQuery.trim()) {
      body.createDiv({ cls: "dida-empty", text: "按标题关键字搜索滴答里的所有待办" });
      return;
    }
    if (!this.searchHits.length) {
      body.createDiv({ cls: "dida-empty", text: "没有匹配的待办" });
      return;
    }
    for (const hit of this.searchHits) {
      const row = body.createDiv({ cls: "dida-search-hit" });
      row.createSpan({ cls: "dida-search-hit-title", text: hit.title || "（无标题）" });
      if (hit.projectId) row.createSpan({ cls: "dida-search-hit-sub", text: this.plugin.store.projectName(hit.projectId) });
      row.addEventListener("click", async () => {
        try {
          const task = await this.plugin.api.getTask(hit.id);
          this.plugin.openEditModal(task);
        } catch (error) {
          new Notice(`打开失败：${this.plugin.describeError(error)}`);
        }
      });
    }
  }

  private renderError(body: HTMLElement): void {
    const box = body.createDiv({ cls: "dida-error-box" });
    if (this.error instanceof McpAuthError) {
      box.createEl("strong", { text: "尚未登录滴答清单" });
      box.createSpan({ text: "登录后这里会读到你的项目和待办。" });
      const btn = box.createEl("button", { cls: "mod-cta", text: "登录滴答清单" });
      btn.addEventListener("click", () => void this.plugin.login().then(() => this.refresh(true)));
      return;
    }
    box.createEl("strong", { text: "加载失败" });
    box.createSpan({ text: this.plugin.describeError(this.error) });
    const btn = box.createEl("button", { text: "重试" });
    btn.addEventListener("click", () => void this.refresh(true));
  }

  // ---------- AI 队列 ----------

  private renderQueueHead(root: HTMLElement): void {
    const head = root.createDiv({ cls: "dida-project-head" });
    this.iconButton(head, "chevron-left", "返回项目总览", () => this.showOverview());
    const text = head.createDiv({ cls: "dida-project-head-text" });
    text.createSpan({ cls: "dida-project-head-name", text: "AI 队列" });
    const n = this.plugin.store.queuedTasks(this.plugin.settings.aiTag).length;
    text.createSpan({ cls: "dida-project-head-sub", text: n ? `${n} 条等 Claude Code 领取 · 标签「${this.plugin.settings.aiTag}」` : `标签「${this.plugin.settings.aiTag}」` });
    this.iconButton(head, "more-horizontal", "队列更多操作", (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("刷新队列").setIcon("refresh-cw").onClick(() => void this.refresh(true)));
      menu.addItem((i) => i.setTitle("派活设置").setIcon("settings").onClick(() => this.plugin.openSettings()));
      menu.showAtMouseEvent(e);
    });
  }

  private renderQueue(body: HTMLElement): void {
    const tag = this.plugin.settings.aiTag;
    const tasks = this.orderWithChildren(this.plugin.store.queuedTasks(tag));
    if (!this.plugin.store.overview) return;
    if (!tasks.length) {
      body.createDiv({ cls: "dida-empty", text: "队列是空的。任务行悬停时点机器人图标，或在菜单里选「派给 AI」。" });
      return;
    }
    const byProject = new Map<string, DidaTask[]>();
    for (const t of tasks) {
      const key = this.plugin.store.projectKey(t.projectId);
      byProject.set(key, [...(byProject.get(key) ?? []), t]);
    }
    for (const [key, list] of byProject) {
      const { open } = this.renderGroup(body, `queue:${key}`, this.plugin.store.projectName(key), list.length);
      if (open) for (const t of list) this.renderTask(body, t, { showProject: false, hideTag: tag });
    }
  }

  // ---------- 项目总览 ----------

  private renderOverview(body: HTMLElement): void {
    const store = this.plugin.store;
    const overview = store.overview;
    const projects = store.projects.filter((p) => p.id !== INBOX_ID);
    if (!projects.length && !overview) return;

    if (overview) {
      body.createDiv({
        cls: "dida-overview-summary",
        text: `${projects.length} 个进行中项目 · ${overview.totalUndone} 条待办${overview.totalOverdue ? ` · ${overview.totalOverdue} 条过期` : ""}`
      });
      const queued = store.queuedTasks(this.plugin.settings.aiTag).length;
      const row = body.createEl("button", { cls: "dida-project-row is-queue", attr: { type: "button" } });
      const ic = row.createSpan({ cls: "dida-project-row-icon" });
      setIcon(ic, "bot");
      row.createSpan({ cls: "dida-project-row-name", text: "AI 队列" });
      const n = row.createSpan({ cls: "dida-project-row-count", text: String(queued) });
      if (!queued) n.addClass("is-zero");
      const chev = row.createSpan({ cls: "dida-project-row-chev" });
      setIcon(chev, "chevron-right");
      row.addEventListener("click", () => this.showQueue());
    }

    const byGroup = new Map<string, DidaProject[]>();
    for (const p of projects) {
      const key = p.groupId && store.groupName(p.groupId) ? p.groupId : "__none__";
      byGroup.set(key, [...(byGroup.get(key) ?? []), p]);
    }
    const groupIds = [...store.groups.map((g) => g.id).filter((id) => byGroup.has(id)), ...(byGroup.has("__none__") ? ["__none__"] : [])];

    for (const gid of groupIds) {
      const list = byGroup.get(gid) ?? [];
      const header = body.createDiv({ cls: "dida-group is-static" });
      header.createSpan({ text: gid === "__none__" ? "未分组" : store.groupName(gid) ?? "未分组" });
      header.createSpan({ cls: "dida-group-count", text: String(list.length) });
      for (const p of list) this.renderProjectRow(body, p);
    }

    const inbox = store.projectById(INBOX_ID);
    if (inbox) {
      const header = body.createDiv({ cls: "dida-group is-static" });
      header.createSpan({ text: "收件箱" });
      this.renderProjectRow(body, inbox);
    }
  }

  private renderProjectRow(body: HTMLElement, project: DidaProject): void {
    const count = this.plugin.store.overview?.counts.get(this.plugin.store.projectKey(project.id));
    const row = body.createEl("button", { cls: "dida-project-row", attr: { type: "button" } });
    const dot = row.createSpan({ cls: "dida-dot" });
    if (project.color) dot.style.background = project.color;
    row.createSpan({ cls: "dida-project-row-name", text: project.name });
    if (count?.overdue) row.createSpan({ cls: "dida-project-row-overdue", text: `${count.overdue} 过期` });
    const n = row.createSpan({ cls: "dida-project-row-count", text: String(count?.undone ?? 0) });
    if (!count?.undone) n.addClass("is-zero");
    const chev = row.createSpan({ cls: "dida-project-row-chev" });
    setIcon(chev, "chevron-right");
    row.addEventListener("click", () => this.showProject(project.id));
  }

  // ---------- 列表 ----------

  private renderGroup(body: HTMLElement, key: string, label: string, count: number, cls = ""): { open: boolean; header: HTMLElement } {
    const open = !this.collapsed.has(key);
    const header = body.createDiv({ cls: `dida-group ${cls}`.trim() });
    const chevron = header.createSpan();
    setIcon(chevron, open ? "chevron-down" : "chevron-right");
    header.createSpan({ text: label });
    header.createSpan({ cls: "dida-group-count", text: String(count) });
    header.createSpan({ cls: "dida-group-spacer" });
    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".dida-group-action")) return;
      if (open) this.collapsed.add(key);
      else this.collapsed.delete(key);
      this.render();
    });
    return { open, header };
  }

  private renderGhost(body: HTMLElement, label: string, prefill: Partial<TaskInput>): void {
    const ghost = body.createDiv({ cls: "dida-ghost" });
    const ic = ghost.createSpan();
    setIcon(ic, "plus");
    ghost.createSpan({ text: label });
    ghost.addEventListener("click", () => this.openCreate(prefill));
  }

  private renderToday(body: HTMLElement): void {
    const snap = this.plugin.store.today;
    if (!snap) return;
    const sortByDue = (list: DidaTask[]): DidaTask[] =>
      [...list].sort((a, b) => (a.dueDate ?? a.startDate ?? "").localeCompare(b.dueDate ?? b.startDate ?? ""));

    if (snap.overdue.length) {
      const { open, header } = this.renderGroup(body, "overdue", "已过期", snap.overdue.length, "is-overdue");
      const action = header.createSpan({ cls: "dida-group-action", text: "顺延到今天" });
      action.addEventListener("click", () => void this.rescheduleOverdue(snap.overdue));
      if (open) for (const t of sortByDue(snap.overdue)) this.renderTask(body, t, { showProject: true });
    }

    const { open } = this.renderGroup(body, "today", "今天", snap.today.length);
    if (open) {
      for (const t of sortByDue(snap.today)) this.renderTask(body, t, { showProject: true, hideTodayLabel: true });
      const today = formatDidaDate(startOfDay(new Date()), true);
      this.renderGhost(body, "添加到今天", { startDate: today, dueDate: today, isAllDay: true });
    }

    if (this.plugin.settings.completedRange !== "none") {
      const { open: openDone } = this.renderGroup(body, "completed", "已完成", snap.completed.length, "is-muted");
      if (openDone) for (const t of snap.completed) this.renderTask(body, t, { showProject: true });
    }
  }

  private async rescheduleOverdue(tasks: DidaTask[]): Promise<void> {
    const ok = await ConfirmModal.ask(this.app, "顺延到今天", `把 ${tasks.length} 条过期待办的日期都改到今天？时间点会清掉，改成全天。`, "顺延");
    if (!ok) return;
    const today = formatDidaDate(startOfDay(new Date()), true);
    let failed = 0;
    for (const task of tasks) {
      try {
        await this.plugin.store.updateTask(task, { startDate: today, dueDate: today, isAllDay: true });
      } catch {
        failed += 1;
      }
    }
    new Notice(failed ? `已顺延 ${tasks.length - failed} 条，${failed} 条失败` : `已顺延 ${tasks.length} 条到今天`);
  }

  private filteredTasks(snap: ProjectSnapshot): DidaTask[] {
    const tasks = this.filterTag ? snap.tasks.filter((t) => (t.tags ?? []).includes(this.filterTag ?? "")) : snap.tasks;
    return this.orderWithChildren(tasks);
  }

  private renderProjectBody(body: HTMLElement, projectId: string, boardMode: boolean): void {
    const snap = this.plugin.store.getProject(projectId);
    if (!snap) return;
    const tasks = this.filteredTasks(snap);

    if (snap.columns.length && boardMode) {
      this.renderBoard(body, projectId, snap, tasks);
      return;
    }

    const ctx: TaskRenderContext = { showProject: false, columns: snap.columns };
    if (snap.columns.length) {
      const byColumn = this.groupByColumn(snap, tasks);
      for (const col of snap.columns) {
        const list = byColumn.get(col.id) ?? [];
        const { open } = this.renderGroup(body, `col:${col.id}`, col.name, list.length);
        if (!open) continue;
        for (const t of list) this.renderTask(body, t, ctx);
        this.renderGhost(body, `添加到${col.name}`, { projectId, columnId: col.id });
      }
      const rest = byColumn.get("__none__") ?? [];
      if (rest.length) {
        const { open } = this.renderGroup(body, "col:none", "未分列", rest.length);
        if (open) for (const t of rest) this.renderTask(body, t, ctx);
      }
      return;
    }

    if (!tasks.length) body.createDiv({ cls: "dida-empty", text: this.filterTag ? "这个标签下没有待办" : "这里暂时没有待办" });
    for (const t of tasks) this.renderTask(body, t, ctx);
    this.renderGhost(body, `添加到${this.plugin.store.projectName(projectId)}`, { projectId });
  }

  private groupByColumn(snap: ProjectSnapshot, tasks: DidaTask[]): Map<string, DidaTask[]> {
    const byColumn = new Map<string, DidaTask[]>();
    for (const t of tasks) {
      const key = t.columnId && snap.columns.some((c) => c.id === t.columnId) ? t.columnId : "__none__";
      byColumn.set(key, [...(byColumn.get(key) ?? []), t]);
    }
    return byColumn;
  }

  // ---------- 看板 ----------

  private renderBoard(body: HTMLElement, projectId: string, snap: ProjectSnapshot, tasks: DidaTask[]): void {
    const byColumn = this.groupByColumn(snap, tasks);
    const columns = [...snap.columns];
    const rest = byColumn.get("__none__") ?? [];

    const jump = body.createDiv({ cls: "dida-board-jump" });
    const lanes = body.createDiv({ cls: "dida-board" });
    const laneEls = new Map<string, HTMLElement>();

    const renderLane = (key: string, name: string, list: DidaTask[], col: DidaColumn | null): void => {
      const lane = lanes.createDiv({ cls: "dida-lane" });
      laneEls.set(key, lane);
      const head = lane.createDiv({ cls: "dida-lane-head" });
      head.createSpan({ text: name });
      head.createSpan({ cls: "dida-group-count", text: String(list.length) });
      head.createSpan({ cls: "dida-group-spacer" });
      if (col) this.iconButton(head, "plus", `添加到${col.name}`, () => this.openCreate({ projectId, columnId: col.id }), "is-small");
      const cards = lane.createDiv({ cls: "dida-lane-cards" });
      for (const t of list) this.renderTask(cards, t, { showProject: false, columns: snap.columns, card: true });
      if (col) {
        if (!list.length) cards.createDiv({ cls: "dida-lane-empty" });
        this.renderGhost(cards, `添加到${col.name}`, { projectId, columnId: col.id });
        lane.addEventListener("dragover", (e) => {
          if (!this.dragging) return;
          e.preventDefault();
          lane.addClass("is-over");
        });
        lane.addEventListener("dragleave", (e) => {
          if (!lane.contains(e.relatedTarget as Node | null)) lane.removeClass("is-over");
        });
        lane.addEventListener("drop", (e) => {
          e.preventDefault();
          lane.removeClass("is-over");
          const task = this.dragging;
          this.dragging = null;
          if (task && task.columnId !== col.id) void this.moveToColumn(task, col);
        });
      }
      const pill = jump.createEl("button", { cls: "dida-board-jump-pill", attr: { type: "button" } });
      pill.createSpan({ text: name });
      pill.createSpan({ cls: "dida-group-count", text: String(list.length) });
      pill.addEventListener("click", () => {
        lane.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
        jump.querySelectorAll(".dida-board-jump-pill").forEach((el) => el.removeClass("is-active"));
        pill.addClass("is-active");
      });
    };

    for (const col of columns) renderLane(col.id, col.name, byColumn.get(col.id) ?? [], col);
    if (rest.length) renderLane("__none__", "未分列", rest, null);
    jump.querySelector(".dida-board-jump-pill")?.addClass("is-active");
  }

  /** 父任务后面紧跟它的子任务，其余按 sortOrder。 */
  private orderWithChildren(tasks: DidaTask[]): DidaTask[] {
    const sorted = [...tasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const ids = new Set(sorted.map((t) => t.id));
    const children = new Map<string, DidaTask[]>();
    const roots: DidaTask[] = [];
    for (const t of sorted) {
      if (t.parentId && ids.has(t.parentId)) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
      else roots.push(t);
    }
    const out: DidaTask[] = [];
    for (const r of roots) {
      out.push(r);
      for (const c of children.get(r.id) ?? []) out.push(c);
    }
    return out;
  }

  // ---------- 任务行 ----------

  private renderTask(parent: HTMLElement, task: DidaTask, ctx: TaskRenderContext): void {
    const row = parent.createDiv({ cls: "dida-task" });
    if (ctx.card) row.addClass("is-card");
    if (task.parentId && !ctx.card) row.addClass("is-child");
    if (task.status === 2) row.addClass("is-done");
    const expanded = this.expanded === task.id;
    if (expanded) row.addClass("is-expanded");

    if (ctx.card && task.status !== 2) {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        this.dragging = task;
        row.addClass("is-dragging");
        e.dataTransfer?.setData("text/plain", task.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        this.dragging = null;
        row.removeClass("is-dragging");
        this.contentEl.querySelectorAll(".dida-lane.is-over").forEach((el) => el.removeClass("is-over"));
      });
    }

    const check = row.createEl("input", { type: "checkbox", cls: `dida-check prio-${task.priority}`, attr: { "aria-label": `完成：${task.title}` } });
    check.checked = task.status === 2;
    check.disabled = task.status === 2;
    check.addEventListener("change", () => {
      if (check.checked) void this.complete(task);
    });

    const body = row.createDiv({ cls: "dida-task-body" });
    const title = body.createDiv({ cls: "dida-task-title", text: task.title || "（无标题）" });
    title.addEventListener("click", () => {
      this.expanded = expanded ? null : task.id;
      this.render();
    });

    const meta = body.createDiv({ cls: "dida-task-meta" });
    const due = describeDue(task);
    if (due.label && !(ctx.hideTodayLabel && due.state === "today" && task.isAllDay !== false)) {
      meta.createSpan({ cls: `dida-due is-${due.state}`, text: due.label });
    }
    if (ctx.showProject) meta.createSpan({ text: this.plugin.store.projectName(task.projectId) });
    if (task.status === 2 && task.completedTime) {
      const done = new Date(task.completedTime);
      if (!Number.isNaN(done.getTime())) meta.createSpan({ text: `${String(done.getHours()).padStart(2, "0")}:${String(done.getMinutes()).padStart(2, "0")} 完成` });
    }
    const queued = isQueued(task, this.plugin.settings.aiTag);
    for (const tag of task.tags ?? []) {
      if (ctx.columns && this.filterTag === tag) continue;
      if (ctx.hideTag === tag) continue;
      const chip = meta.createSpan({ cls: "dida-tag", text: this.plugin.tagLabel(tag) });
      if (tag === this.plugin.settings.aiTag) chip.addClass("is-queue");
      else this.plugin.applyTagColor(chip, tag);
    }
    const linked = firstLinkedPath(task.content);
    if (linked) {
      const name = linked.split("/").pop() ?? linked;
      const btn = meta.createEl("button", { cls: "dida-note-btn", attr: { type: "button", "aria-label": `打开关联笔记：${name}`, title: linked } });
      setIcon(btn, "link");
      if (/^正文：\[/m.test(task.content ?? "")) btn.addClass("is-body");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.app.workspace.openLinkText(linked, "", false);
      });
    } else if (!ctx.showProject && /^正文：待建/m.test(task.content ?? "")) {
      meta.createSpan({ text: "正文待建" });
    }

    const actions = row.createDiv({ cls: "dida-task-actions" });
    if (task.status !== 2) this.iconButton(actions, "bot", queued ? "再派给 AI（已在队列）" : "派给 AI", () => void this.plugin.dispatchTask(task), queued ? "is-accent" : "");
    this.iconButton(actions, "pencil", "编辑", () => this.plugin.openEditModal(task));
    this.iconButton(actions, "more-horizontal", "更多", (e) => this.taskMenu(task, e, ctx));

    if (expanded) this.renderDetails(row, task, ctx);
  }

  private renderDetails(row: HTMLElement, task: DidaTask, ctx: TaskRenderContext): void {
    const details = row.createDiv({ cls: "dida-task-details" });
    if (task.content?.trim()) {
      const md = details.createDiv({ cls: "dida-md" });
      void MarkdownRenderer.render(this.app, task.content, md, "", this);
    } else if (task.desc?.trim()) {
      details.createDiv({ cls: "dida-md", text: task.desc });
    }
    const actions = details.createDiv({ cls: "dida-detail-actions" });
    if (task.status !== 2) {
      const queued = isQueued(task, this.plugin.settings.aiTag);
      actions.createEl("button", { text: queued ? "再派给 AI" : "派给 AI", cls: "is-dispatch" }).addEventListener("click", () => void this.plugin.dispatchTask(task));
      if (queued) actions.createEl("button", { text: "移出队列" }).addEventListener("click", () => void this.plugin.undispatchTask(task));
    }
    if (ctx.columns?.length) {
      const next = ctx.columns[ctx.columns.findIndex((c) => c.id === task.columnId) + 1];
      if (next) actions.createEl("button", { text: `移到${next.name}` }).addEventListener("click", () => void this.moveToColumn(task, next));
    }
    actions.createEl("button", { text: "编辑" }).addEventListener("click", () => this.plugin.openEditModal(task));
    actions.createEl("button", { text: "改日期" }).addEventListener("click", (e) => this.dateMenu(task).showAtMouseEvent(e));
    actions.createEl("button", { text: "删除", cls: "is-danger" }).addEventListener("click", () => void this.remove(task));
  }

  private setDate(task: DidaTask, d: Date | null): void {
    const when = d ? formatDidaDate(d, true) : CLEAR_DATE;
    void this.plugin.store
      .updateTask(task, { startDate: when, dueDate: when, isAllDay: true })
      .catch((error: unknown) => new Notice(`改期失败：${this.plugin.describeError(error)}`));
  }

  private dateMenu(task: DidaTask): Menu {
    const menu = new Menu();
    const today = startOfDay(new Date());
    menu.addItem((i) => i.setTitle("今天").onClick(() => this.setDate(task, today)));
    menu.addItem((i) => i.setTitle("明天").onClick(() => this.setDate(task, addDays(today, 1))));
    menu.addItem((i) => i.setTitle("下周一").onClick(() => this.setDate(task, addDays(today, ((8 - today.getDay()) % 7) || 7))));
    menu.addItem((i) => i.setTitle("清除日期").onClick(() => this.setDate(task, null)));
    return menu;
  }

  private taskMenu(task: DidaTask, e: MouseEvent, ctx: TaskRenderContext): void {
    const menu = new Menu();
    const linked = firstLinkedPath(task.content);
    if (task.status !== 2) {
      const queued = isQueued(task, this.plugin.settings.aiTag);
      menu.addItem((i) => i.setTitle(queued ? "再派给 AI" : "派给 AI").setIcon("bot").onClick(() => void this.plugin.dispatchTask(task)));
      menu.addItem((i) => i.setTitle(queued ? "移出 AI 队列" : "只进 AI 队列，不打开 MakerPilot").setIcon("list-plus").onClick(() => void (queued ? this.plugin.undispatchTask(task) : this.plugin.dispatchTask(task, false))));
      menu.addSeparator();
    }
    if (linked) menu.addItem((i) => i.setTitle("打开关联笔记").setIcon("link").onClick(() => void this.app.workspace.openLinkText(linked, "", false)));
    menu.addItem((i) => i.setTitle("编辑").setIcon("pencil").onClick(() => this.plugin.openEditModal(task)));
    menu.addSeparator();
    const today = startOfDay(new Date());
    menu.addItem((i) => i.setTitle("排到今天").setIcon("calendar").onClick(() => this.setDate(task, today)));
    menu.addItem((i) => i.setTitle("排到明天").setIcon("calendar").onClick(() => this.setDate(task, addDays(today, 1))));
    menu.addItem((i) => i.setTitle("清除日期").setIcon("calendar-x").onClick(() => this.setDate(task, null)));
    menu.addSeparator();
    for (const p of PRIORITIES) {
      menu.addItem((i) =>
        i
          .setTitle(`优先级：${PRIORITY_LABEL[p]}`)
          .setChecked(task.priority === p)
          .onClick(() => void this.plugin.store.updateTask(task, { priority: p }).catch((error: unknown) => new Notice(this.plugin.describeError(error))))
      );
    }
    menu.addSeparator();
    if (ctx.columns?.length) {
      for (const col of ctx.columns) {
        if (col.id === task.columnId) continue;
        menu.addItem((i) => i.setTitle(`移到列：${col.name}`).setIcon("columns").onClick(() => void this.moveToColumn(task, col)));
      }
    }
    menu.addItem((i) =>
      i
        .setTitle("移到项目…")
        .setIcon("folder-input")
        .onClick(() =>
          new ProjectSuggestModal(
            this.app,
            this.plugin.store,
            (p) => void this.plugin.store.moveTask(task, p.id).then(() => new Notice(`已移到「${p.name}」`)).catch((error: unknown) => new Notice(this.plugin.describeError(error))),
            [this.plugin.store.projectKey(task.projectId)]
          ).open()
        )
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("在滴答清单网页版打开").setIcon("external-link").onClick(() => window.open(taskWebUrl(task))));
    menu.addItem((i) => i.setTitle("删除").setIcon("trash").setWarning(true).onClick(() => void this.remove(task)));
    menu.showAtMouseEvent(e);
  }

  private async moveToColumn(task: DidaTask, col: DidaColumn): Promise<void> {
    try {
      await this.plugin.store.updateTask(task, { columnId: col.id });
      new Notice(`已移到「${col.name}」`);
    } catch (error) {
      new Notice(`移动失败：${this.plugin.describeError(error)}`);
    }
  }

  private async complete(task: DidaTask): Promise<void> {
    try {
      await this.plugin.store.completeTask(task);
    } catch (error) {
      new Notice(`完成失败：${this.plugin.describeError(error)}`, 6000);
    }
  }

  private async remove(task: DidaTask): Promise<void> {
    const ok = await ConfirmModal.ask(this.app, "删除待办", `「${task.title}」会从滴答清单里彻底删除，不可恢复。`, "删除", true);
    if (!ok) return;
    try {
      await this.plugin.store.deleteTask(task);
      new Notice("已删除");
    } catch (error) {
      new Notice(`删除失败：${this.plugin.describeError(error)}`, 6000);
    }
  }

  private openCreate(prefill: Partial<TaskInput> = {}): void {
    this.plugin.openCreateModal({ projectId: this.currentProjectId(), ...prefill });
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLElement {
    const btn = parent.createEl("button", { cls: `dida-ibtn ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
    setIcon(btn, icon);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return btn;
  }
}
