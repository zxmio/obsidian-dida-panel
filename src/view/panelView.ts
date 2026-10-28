import { ItemView, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import type { PanelTab, ProjectViewMode } from "../settings.ts";
import { describeRepeat } from "../dida/repeat.ts";
import { CLEAR_DATE, describeDue, formatDidaDate, parseDidaDate, relativeTime, rescheduleDates, startOfDay } from "../dida/dates.ts";
import { boundNotePath, taskWebUrl } from "../dida/deeplink.ts";
import { parseQuickAdd } from "../dida/quickAdd.ts";
import { INBOX_ID, PRIORITIES, PRIORITY_LABEL, taskBody, type ChecklistItem, type DidaColumn, type DidaProject, type DidaTask, type TaskInput, type TaskSearchHit } from "../dida/types.ts";
import { McpAuthError } from "../mcp/client.ts";
import { isQueued } from "../dispatch/prompt.ts";
import { targetInfo } from "../dispatch/targets.ts";
import type { ProjectSnapshot } from "../store.ts";
import { ConfirmModal } from "./confirm.ts";
import { ProjectSuggestModal } from "./projectSuggest.ts";
import { ChatDock } from "./chatDock.ts";
import { QuickChips } from "./quickChips.ts";
import { openDispatchPicker } from "./dispatchPicker.ts";
import { openTaskActions } from "./taskActions.ts";
import { openDatePicker } from "./datePanel.ts";
import { renderTaskMarkdown } from "./markdown.ts";
import { openActionMenu, openPrompt, type ActionItem, type ActionMenuSpec } from "./actionMenu.ts";
import { ProjectModal, archiveProject } from "./projectModal.ts";
import type { QuickPopover } from "./quickPopover.ts";
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
  /** 画在父任务卡片里的子任务行 */
  nested?: boolean;
}

/** 看板的一条泳道。项目列、收件箱列、今天的「过期 / 今天 / 已完成」都走它。 */
interface LaneSpec {
  key: string;
  name: string;
  tasks: DidaTask[];
  ctx: TaskRenderContext;
  cls?: string;
  /** 泳道右上角的加号与底部「添加到…」 */
  addPrefill?: Partial<TaskInput>;
  /** 泳道头部的文字操作，比如「全部顺延」 */
  action?: { label: string; run: () => void };
  /** 能不能把这张卡拖进来；不给就不接受拖放 */
  accepts?: (task: DidaTask) => boolean;
  onDrop?: (task: DidaTask) => void;
  /** 泳道没有任务、也没有添加行时的提示 */
  emptyText?: string;
  /** 泳道「···」和右键：分组操作面板 */
  menu?: (rect: DOMRect) => void;
}

/** 今天视图的看板模式记在 viewModes 的这个键下，和项目 id 不冲突。 */
const TODAY_MODE_KEY = "__today__";



/** 弹出面板锚在被点的按钮上；拿不到按钮就锚在鼠标处。 */
function anchorOf(e: MouseEvent): DOMRect {
  return e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : new DOMRect(e.clientX, e.clientY, 0, 0);
}

/** 「💌陪跑服务」拆成 emoji 和名称；只认开头的一个 emoji（含变体符和组合）。 */
function splitEmoji(name: string): { emoji: string | null; name: string } {
  const m = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)\s*/u.exec(name);
  return m ? { emoji: m[1], name: name.slice(m[0].length) } : { emoji: null, name };
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
  private quickChips: QuickChips | null = null;
  /** 刚在这条任务下加过子任务：重画后把光标放回它的子任务输入框，方便连续添加 */
  private subtaskFocus: string | null = null;
  /** 父任务卡片里展开的那条子任务 */
  private expandedChild: string | null = null;
  /** 刚在这条泳道顶部加过任务：重画后把光标放回去 */
  private laneAddFocus: string | null = null;
  private actionPop: QuickPopover | null = null;
  /** 快速添加选的分组，只对选的那个项目有效；id 为 null 是「未分组」 */
  private quickColumn: { key: string; id: string | null } | null = null;
  private dragging: DidaTask | null = null;
  private mainEl: HTMLElement | null = null;
  private dock: ChatDock | null = null;
  /** 多选模式：点任务是选中而不是展开，底部出批量操作栏；⌘ / Ctrl 点任务也会进入 */
  private selecting = false;
  private readonly selected = new Map<string, DidaTask>();
  /** 这一轮画出来的未完成任务，「全选」用 */
  private visibleTasks: DidaTask[] = [];
  /** 顶栏铺满按钮画的是侧栏态还是铺满态；面板被拖到别处时据此重画 */
  private headerDocked: boolean | null = null;

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
    this.watchStatusBar();
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.registerDomEvent(this.contentEl.doc, "keydown", (e) => {
      if (e.key === "Escape" && this.selecting && !this.contentEl.doc.querySelector(".modal-container, .dida-pop")) this.exitSelecting();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      if (this.headerDocked !== null && this.headerDocked !== this.plugin.inSidebar(this)) this.render();
    }));
    this.render();
    await this.refresh(false);
  }

  /**
   * Obsidian 的状态栏浮在工作区右下角，会盖住侧栏底部的输入框。
   * 量出它和本视图重叠的高度，写进 --dida-status-gap 给底部留位。
   */
  private watchStatusBar(): void {
    let frame = 0;
    const sync = (): void => {
      frame = 0;
      const el = this.contentEl;
      const bar = el.doc.body.querySelector<HTMLElement>(".status-bar");
      let gap = 0;
      if (bar && bar.offsetParent !== null) {
        const a = el.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        if (b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top) gap = Math.ceil(a.bottom - b.top);
      }
      el.style.setProperty("--dida-status-gap", `${gap}px`);
    };
    const schedule = (): void => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };
    this.registerEvent(this.app.workspace.on("resize", schedule));
    this.registerEvent(this.app.workspace.on("layout-change", schedule));
    this.registerEvent(this.app.workspace.on("css-change", schedule));
    const observer = new ResizeObserver(schedule);
    observer.observe(this.contentEl);
    this.register(() => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    });
    schedule();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dock?.destroy();
    this.dock = null;
    this.quickChips?.destroy();
    this.quickChips = null;
    this.actionPop?.close();
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

  /** 体检的默认范围：项目详情或收件箱就审它，其他位置审全部。 */
  reviewScope(): string | null {
    if (this.tab === "inbox") return INBOX_ID;
    if (this.tab === "project" && this.projectId && !this.queueMode) return this.projectId;
    return null;
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

    this.quickChips?.destroy();
    this.quickChips = null;
    this.visibleTasks = [];
    root.empty();
    root.addClass("dida-panel");
    this.renderHeader(root);
    this.renderTabs(root);

    const inProject = this.tab === "project" && !!this.projectId;
    const inQueue = this.tab === "project" && !this.projectId && this.queueMode;
    const snap = inProject ? this.plugin.store.getProject(this.projectId ?? "") : null;
    const inboxSnap = this.tab === "inbox" ? this.plugin.store.getProject(INBOX_ID) : null;
    let boardMode = false;
    if (inProject) boardMode = !!snap?.columns.length && this.modeFor(this.projectId ?? "") === "board";
    else if (this.tab === "inbox") boardMode = !!inboxSnap?.columns.length && this.modeFor(INBOX_ID) === "board";
    else if (this.tab === "today") boardMode = this.modeFor(TODAY_MODE_KEY) === "board";
    if (inProject) this.renderProjectHead(root, this.projectId ?? "", snap, boardMode);
    if (inQueue) this.renderQueueHead(root);
    if (this.tab === "today") this.renderViewBar(root, TODAY_MODE_KEY, this.todaySummary(), boardMode, true);
    if (this.tab === "inbox") this.renderViewBar(root, INBOX_ID, inboxSnap ? `${inboxSnap.tasks.length} 条待办` : "", boardMode, !!inboxSnap?.columns.length);
    if (this.tab === "search") this.renderSearchBox(root);
    else if (!(this.tab === "project" && !this.projectId)) this.renderQuickAdd(root);

    const body = root.createDiv({ cls: "dida-body" });
    if (boardMode) body.addClass("is-board");
    this.listEl = body;
    if (this.error) this.renderError(body);
    else if (this.tab === "today") {
      if (boardMode) this.renderTodayBoard(body);
      else this.renderToday(body);
    } else if (this.tab === "inbox") this.renderProjectBody(body, INBOX_ID, boardMode);
    else if (this.tab === "project") {
      if (inQueue) this.renderQueue(body);
      else if (!this.projectId) this.renderOverview(body);
      else this.renderProjectBody(body, this.projectId, boardMode);
    } else this.renderSearchResults(body);

    if (this.loading && body.childElementCount === 0) body.createDiv({ cls: "dida-loading", text: "加载中…" });
    if (this.selecting) this.renderBatchBar(root);
    body.scrollTop = prevScroll;
    body.scrollLeft = prevScrollLeft;
    this.dock?.refreshContext();
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "dida-header" });
    header.createSpan({ cls: "dida-header-title", text: "滴答清单" });
    const synced = this.plugin.store.lastRefreshAt ? `${relativeTime(this.plugin.store.lastRefreshAt)}同步，点击立即同步` : "立即同步";
    this.iconButton(header, "search", "搜索", () => this.setTab("search"), this.tab === "search" ? "is-active" : "");
    this.iconButton(header, "stethoscope", "任务体检", () => this.plugin.openReview());
    this.iconButton(header, "refresh-cw", synced, () => void this.refresh(true), this.loading ? "is-loading" : "");
    this.iconButton(header, "plus", "新建待办", () => this.openCreate(), "is-accent");
    const docked = this.plugin.inSidebar(this);
    this.headerDocked = docked;
    this.iconButton(header, docked ? "maximize-2" : "minimize-2", docked ? "铺满" : "收回侧栏", () => void this.plugin.toggleFullscreen(this));
    this.iconButton(header, "more-horizontal", "更多", (e) =>
      this.showActions(anchorOf(e), {
        groups: [
          [
            { icon: "folder-plus", label: "新建项目…", run: () => this.openNewProject() },
            { icon: "list-checks", label: this.selecting ? "退出多选" : "多选（批量操作）", run: () => (this.selecting ? this.exitSelecting() : this.enterSelecting()) },
            { icon: "tags", label: "管理标签…", run: () => this.plugin.openTagManager() }
          ],
          [
            { icon: "settings", label: "插件设置", run: () => this.plugin.openSettings() },
            { icon: "external-link", label: "在滴答清单网页版打开", run: () => window.open("https://dida365.com/webapp/") }
          ],
          [{ icon: "log-in", label: this.plugin.isLoggedIn() ? "重新登录" : "登录滴答清单", run: () => void this.plugin.login().then(() => this.refresh(true)) }]
        ]
      })
    );
  }

  private renderTabs(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: "dida-tabs" });
    const store = this.plugin.store;
    const inboxCount = store.getProject(INBOX_ID)?.tasks.length;
    const pinned = this.pinnedProjects();
    // 正在看置顶的项目时，亮的是它自己的页签，不是「项目」
    const onPinned = this.tab === "project" && !this.queueMode && !!this.projectId && pinned.some((p) => p.id === this.projectId);
    const defs: Array<[PanelTab, string, number | undefined]> = [
      ["today", "今天", undefined],
      ["inbox", "收件箱", inboxCount],
      ["project", "项目", undefined]
    ];
    for (const [tab, label, count] of defs) {
      const btn = tabs.createEl("button", { cls: "dida-tab", text: label, attr: { type: "button" } });
      if (count !== undefined && count > 0) btn.createSpan({ cls: "dida-tab-count", text: String(count) });
      btn.toggleClass("is-active", this.tab === tab && !(tab === "project" && onPinned));
      btn.addEventListener("click", () => this.setTab(tab));
    }
    if (!pinned.length) return;
    tabs.createSpan({ cls: "dida-tab-divider" });
    for (const project of pinned) {
      const { emoji, name } = splitEmoji(project.name);
      const alias = this.plugin.settings.pinnedNames[project.id];
      const btn = tabs.createEl("button", { cls: "dida-tab is-pinned", attr: { type: "button", title: project.name } });
      if (emoji) btn.createSpan({ cls: "dida-tab-emoji", text: emoji });
      btn.createSpan({ cls: "dida-tab-label", text: alias || name || project.name });
      const count = store.getProject(project.id)?.tasks.length ?? store.overview?.counts.get(store.projectKey(project.id))?.undone;
      if (count) btn.createSpan({ cls: "dida-tab-count", text: String(count) });
      btn.toggleClass("is-active", onPinned && this.projectId === project.id);
      btn.addEventListener("click", () => this.showProject(project.id));
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        {
          const rect = new DOMRect(e.clientX, e.clientY, 0, 0);
          this.showActions(rect, this.projectActions(project, false, rect));
        }
      });
    }
    // 页签多了横向滚动，把亮着的那个滚进视野
    tabs.querySelector<HTMLElement>(".dida-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** 置顶的项目：按置顶先后排，已归档或删掉的跳过（不改设置，项目回来还在原位） */
  private pinnedProjects(): DidaProject[] {
    const store = this.plugin.store;
    return this.plugin.settings.pinnedProjects
      .map((id) => store.projects.find((p) => p.id === id))
      .filter((p): p is DidaProject => !!p && p.id !== INBOX_ID);
  }

  private async togglePin(project: DidaProject): Promise<void> {
    const settings = this.plugin.settings;
    const pinned = settings.pinnedProjects.includes(project.id);
    settings.pinnedProjects = pinned ? settings.pinnedProjects.filter((id) => id !== project.id) : [...settings.pinnedProjects, project.id];
    await this.plugin.saveSettings();
    new Notice(pinned ? `已取消置顶「${project.name}」` : `已把「${project.name}」置顶到页签栏`);
    this.render();
  }

  /** 置顶页签的显示名，只改页签上的字，滴答里的项目名不动；传 null 恢复项目名 */
  private async setPinnedName(project: DidaProject, alias: string | null): Promise<void> {
    const names = { ...this.plugin.settings.pinnedNames };
    if (alias) names[project.id] = alias;
    else delete names[project.id];
    this.plugin.settings.pinnedNames = names;
    await this.plugin.saveSettings();
    this.render();
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

    if (snap?.columns.length) this.renderModeSeg(head, projectId, boardMode);

    this.iconButton(head, "more-horizontal", "项目更多操作", (e) => {
      const p = project ?? { id: projectId, name: store.projectName(projectId), groupId: null };
      {
        const rect = anchorOf(e);
        this.showActions(rect, this.projectActions(p as DidaProject, true, rect));
      }
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

  /** 列表 / 看板切换 */
  private renderModeSeg(parent: HTMLElement, key: string, boardMode: boolean): void {
    const seg = parent.createDiv({ cls: "dida-seg", attr: { role: "group", "aria-label": "显示方式" } });
    const list = seg.createEl("button", { text: "列表", attr: { type: "button" } });
    const board = seg.createEl("button", { text: "看板", attr: { type: "button" } });
    list.toggleClass("is-on", !boardMode);
    board.toggleClass("is-on", boardMode);
    list.addEventListener("click", () => this.setMode(key, "list"));
    board.addEventListener("click", () => this.setMode(key, "board"));
  }

  /** 今天、收件箱页签顶部的一行：左边数字，右边列表 / 看板。 */
  private renderViewBar(root: HTMLElement, key: string, summary: string, boardMode: boolean, canBoard: boolean): void {
    const bar = root.createDiv({ cls: "dida-viewbar" });
    bar.createSpan({ cls: "dida-viewbar-text", text: summary });
    if (canBoard) this.renderModeSeg(bar, key, boardMode);
  }

  private todaySummary(): string {
    const snap = this.plugin.store.today;
    if (!snap) return "";
    const parts = [`${snap.today.length} 条今天`];
    if (snap.overdue.length) parts.unshift(`${snap.overdue.length} 条过期`);
    if (snap.completed.length) parts.push(`${snap.completed.length} 条已完成`);
    return parts.join(" · ");
  }

  private renderQuickAdd(root: HTMLElement): void {
    const wrap = root.createDiv({ cls: "dida-quick" });
    const icon = wrap.createSpan();
    setIcon(icon, "plus");
    const input = wrap.createEl("input", { type: "text", cls: "dida-quick-input", attr: { "aria-label": "快速添加待办" } });
    input.placeholder = `添加待办到「${this.plugin.store.projectName(this.currentProjectId())}」`;
    input.value = this.quickValue;
    input.title = "速记：明天 14:00 · !高 · #标签 · ^项目";
    const chips = new QuickChips(root.createDiv({ cls: "dida-quick-chips" }), {
      plugin: this.plugin,
      input,
      defaultProjectId: () => this.currentProjectId(),
      matchProject: (q) => this.matchProject(q),
      columns: (id) => this.quickColumns(id),
      column: (id) => (this.quickColumn?.key === this.plugin.store.projectKey(id) ? this.quickColumn.id : undefined),
      setColumn: (id, columnId) => {
        this.quickColumn = columnId === undefined ? null : { key: this.plugin.store.projectKey(id), id: columnId };
        chips.render();
      },
      setValue: (next, refocus) => {
        input.value = next;
        this.quickValue = next;
        chips.render();
        if (refocus) {
          input.focus();
          input.setSelectionRange(next.length, next.length);
        }
      }
    });
    this.quickChips = chips;
    input.addEventListener("input", () => {
      this.quickValue = input.value;
      chips.render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.quickAdd(input);
      }
    });
    chips.render();
    if (this.quickFocused) {
      window.setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 0);
    }
  }

  /** 快速添加目标项目的分组；看板项目和收件箱没缓存时顺手加载，加载完面板会重画。 */
  private quickColumns(projectId: string): DidaColumn[] | null {
    const store = this.plugin.store;
    const snap = store.getProject(projectId);
    if (snap) return snap.columns;
    const project = store.projectById(projectId);
    if (!project || (project.viewMode !== "kanban" && store.projectKey(projectId) !== INBOX_ID)) return [];
    void store.loadProject(projectId).catch(() => null);
    return null;
  }

  /** 速记里的 ^项目 按名称匹配：先全等，再包含；忽略空格和 emoji。 */
  private matchProject(query: string): DidaProject | null {
    const q = stripDecor(query);
    const projects = this.plugin.store.projects;
    return projects.find((p) => stripDecor(p.name) === q) ?? projects.find((p) => stripDecor(p.name).includes(q)) ?? null;
  }

  private async quickAdd(input: HTMLInputElement): Promise<void> {
    const parsed = parseQuickAdd(input.value);
    if (!parsed.title) {
      new Notice("先写点内容");
      return;
    }
    let projectId = this.currentProjectId();
    if (parsed.projectQuery) {
      const hit = this.matchProject(parsed.projectQuery);
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
    const columnId = this.quickChips?.columnFor(projectId);
    if (columnId) taskInput.columnId = columnId;
    if (parsed.date) {
      const when = formatDidaDate(parsed.date, parsed.allDay);
      taskInput.startDate = when;
      taskInput.dueDate = when;
      taskInput.isAllDay = parsed.allDay;
    }
    // 用只读而不是禁用：禁用会把焦点踢掉，加完一条就没法接着打下一条
    input.readOnly = true;
    try {
      await this.plugin.store.createTask(taskInput);
      this.quickValue = "";
      new Notice(`已添加到「${this.plugin.store.projectName(projectId)}」`);
    } catch (error) {
      new Notice(`添加失败：${this.plugin.describeError(error)}`, 6000);
    } finally {
      input.readOnly = false;
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
      // 搜索结果只有标题，右键时先取完整任务再开操作面板
      row.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        const at = new DOMRect(e.clientX, e.clientY, 0, 0);
        try {
          const task = await this.plugin.api.getTask(hit.id);
          this.openTaskActions(task, { showProject: true }, at);
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
    this.iconButton(head, "more-horizontal", "队列更多操作", (e) =>
      this.showActions(anchorOf(e), {
        groups: [
          [
            { icon: "refresh-cw", label: "刷新队列", run: () => void this.refresh(true) },
            { icon: "settings", label: "派活设置", run: () => this.plugin.openSettings() }
          ]
        ]
      })
    );
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

    if (overview) this.renderOverviewStats(body, overview.totalOverdue);
    this.renderOverviewList(body.createDiv({ cls: "dida-ov-list" }), projects);
  }

  /** 总览顶部的数字条：今天、过期、AI 队列，点进对应视图。 */
  private renderOverviewStats(body: HTMLElement, overdue: number): void {
    const store = this.plugin.store;
    const today = (store.overview?.tasks ?? []).filter((t) => describeDue(t).state === "today").length;
    const queued = store.queuedTasks(this.plugin.settings.aiTag).length;
    const stats = body.createDiv({ cls: "dida-ov-stats" });
    // 一张细卡分三格：标签一行小字，下面是数字；为零的数字转浅灰
    const stat = (label: string, n: number, cls: string, onClick: () => void): void => {
      const card = stats.createEl("button", { cls: `dida-ov-stat ${cls}`, attr: { type: "button" } });
      card.toggleClass("is-zero", !n);
      card.createDiv({ cls: "dida-ov-stat-top" }).createSpan({ cls: "dida-ov-stat-label", text: label });
      card.createDiv({ cls: "dida-ov-stat-num", text: String(n) });
      card.addEventListener("click", onClick);
    };
    stat("今天", today, "is-today", () => this.setTab("today"));
    stat("过期", overdue, "is-overdue", () => this.setTab("today"));
    stat("AI 队列", queued, "is-queue", () => this.showQueue());
  }

  private renderOverviewList(list: HTMLElement, projects: DidaProject[]): void {
    const store = this.plugin.store;
    list.empty();
    const inbox = store.projectById(INBOX_ID);
    if (inbox) this.renderProjectRow(list.createDiv({ cls: "dida-ov-pinned" }), inbox);

    const byGroup = new Map<string, DidaProject[]>();
    for (const p of projects) {
      const key = p.groupId && store.groupName(p.groupId) ? p.groupId : "__none__";
      byGroup.set(key, [...(byGroup.get(key) ?? []), p]);
    }
    // 空文件夹也列出来，刚建的文件夹才看得到
    const groupIds = [...store.groups.map((g) => g.id), ...(byGroup.has("__none__") ? ["__none__"] : [])];

    for (const gid of groupIds) {
      const items = byGroup.get(gid) ?? [];
      const key = `ov:${gid}`;
      const open = !this.collapsed.has(key);
      const total = items.reduce((sum, p) => sum + (store.overview?.counts.get(store.projectKey(p.id))?.undone ?? 0), 0);
      const section = list.createDiv({ cls: "dida-ov-group" });
      const header = section.createDiv({ cls: "dida-ov-group-head" });
      header.toggleClass("is-collapsed", !open);
      setIcon(header.createSpan({ cls: "dida-ov-group-chev" }), "chevron-down");
      header.createSpan({ cls: "dida-ov-group-name", text: gid === "__none__" ? "未分组" : store.groupName(gid) ?? "未分组" });
      header.createSpan({ cls: "dida-ov-group-meta", text: items.length ? `${items.length} 个项目 · ${total} 条` : "空文件夹" });
      header.addEventListener("click", () => {
        if (open) this.collapsed.add(key);
        else this.collapsed.delete(key);
        this.renderOverviewList(list, projects);
      });
      if (gid !== "__none__") {
        const menu = (rect: DOMRect): void => this.showActions(rect, this.folderActions(gid, items.length, rect));
        const more = this.iconButton(header, "more-horizontal", "文件夹操作", (e) => menu((e.currentTarget as HTMLElement).getBoundingClientRect()), "is-small dida-ov-group-more");
        more.addEventListener("click", (e) => e.stopPropagation());
        header.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          menu(new DOMRect(e.clientX, e.clientY, 0, 0));
        });
      }
      if (open) for (const p of items) this.renderProjectRow(section, p);
    }

    const foot = list.createDiv({ cls: "dida-ov-foot" });
    const add = foot.createEl("button", { cls: "dida-new-column-btn dida-ov-new", attr: { type: "button" } });
    setIcon(add.createSpan(), "plus");
    add.createSpan({ text: "新建项目" });
    add.addEventListener("click", () => this.openNewProject());
    const addFolder = foot.createEl("button", { cls: "dida-new-column-btn dida-ov-new", attr: { type: "button" } });
    setIcon(addFolder.createSpan(), "folder-plus");
    addFolder.createSpan({ text: "新建文件夹" });
    addFolder.addEventListener("click", () =>
      openPrompt(this.contentEl.doc, addFolder.getBoundingClientRect(), {
        title: "新建文件夹",
        placeholder: "文件夹名称",
        confirm: "新建",
        onSubmit: (name) =>
          void this.plugin.store
            .createGroup(name)
            .then(() => new Notice(`已新建文件夹「${name}」`))
            .catch((error: unknown) => new Notice(`新建文件夹失败：${this.plugin.describeError(error)}`, 6000))
      })
    );
  }

  /** 文件夹操作：在里面新建项目、改名、删除（删除只删文件夹，里面的项目留着、移出文件夹） */
  private folderActions(groupId: string, projectCount: number, rect: DOMRect): ActionMenuSpec {
    const store = this.plugin.store;
    const name = store.groupName(groupId) ?? "文件夹";
    const fail = (what: string) => (error: unknown) => new Notice(`${what}失败：${this.plugin.describeError(error)}`, 6000);
    return {
      head: { title: name, sub: projectCount ? `${projectCount} 个项目` : "空文件夹" },
      groups: [
        [{ icon: "plus", label: "在这里新建项目…", run: () => this.openNewProject(groupId) }],
        [
          {
            icon: "pencil",
            label: "重命名…",
            run: () =>
              openPrompt(this.contentEl.doc, rect, {
                title: "重命名文件夹",
                placeholder: name,
                confirm: "改成",
                value: name,
                onSubmit: (next) => void store.renameGroup(groupId, next).catch(fail("重命名"))
              })
          },
          {
            icon: "folder-x",
            label: projectCount ? "删除文件夹（项目保留）" : "删除文件夹",
            danger: true,
            run: () =>
              void store
                .deleteGroup(groupId)
                .then(() => new Notice(projectCount ? `已删除「${name}」，里面 ${projectCount} 个项目移到了未分组` : `已删除「${name}」`))
                .catch(fail("删除文件夹"))
          }
        ]
      ]
    };
  }

  /** 项目行：名称开头的 emoji 当图标，没有就用项目颜色点；悬停时数字换成「新建 / 更多」。 */
  private renderProjectRow(parent: HTMLElement, project: DidaProject): void {
    const store = this.plugin.store;
    const count = store.overview?.counts.get(store.projectKey(project.id));
    const undone = count?.undone ?? 0;
    const row = parent.createDiv({ cls: "dida-ov-row", attr: { role: "button", tabindex: "0" } });
    row.toggleClass("is-empty", !undone);
    const { emoji, name } = splitEmoji(project.name);
    const icon = row.createSpan({ cls: "dida-ov-row-icon" });
    if (project.id === INBOX_ID) setIcon(icon, "inbox");
    else if (emoji) icon.setText(emoji);
    else {
      const dot = icon.createSpan({ cls: "dida-ov-row-dot" });
      if (project.color) dot.style.background = project.color;
    }
    if (emoji && project.color) {
      // 有 emoji 的项目也保留滴答里设的颜色，画成图标下的一道细线
      icon.addClass("has-color");
      icon.style.setProperty("--dida-project-color", project.color);
    }
    row.createSpan({ cls: "dida-ov-row-name", text: name || project.name });

    const meta = row.createSpan({ cls: "dida-ov-row-meta" });
    if (count?.overdue) meta.createSpan({ cls: "dida-ov-row-overdue", text: `${count.overdue} 过期` });
    meta.createSpan({ cls: "dida-ov-row-count", text: undone ? String(undone) : "" });

    const actions = row.createSpan({ cls: "dida-ov-row-actions" });
    const action = (ic: string, label: string, run: (e: MouseEvent) => void): void => {
      const b = actions.createEl("button", { cls: "dida-ov-row-action", attr: { type: "button", "aria-label": label } });
      setIcon(b, ic);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run(e);
      });
    };
    action("plus", "新建待办到此项目", () => this.plugin.openCreateModal({ projectId: project.id }));
    action("more-horizontal", "更多", (e) => {
      const rect = anchorOf(e);
      this.showActions(rect, this.projectActions(project, false, rect));
    });

    row.addEventListener("click", () => this.showProject(project.id));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.showProject(project.id);
      }
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      {
          const rect = new DOMRect(e.clientX, e.clientY, 0, 0);
          this.showActions(rect, this.projectActions(project, false, rect));
        }
    });
  }

  /** 置顶页签改名：输入新名字；改过的再给一个恢复原名 */
  private pinnedNameActions(project: DidaProject, rect: DOMRect): ActionItem[] {
    const alias = this.plugin.settings.pinnedNames[project.id];
    const { name } = splitEmoji(project.name);
    const rename = {
      icon: "text-cursor-input",
      label: "页签名称…",
      run: () =>
        openPrompt(this.contentEl.doc, rect, {
          title: "页签上显示的名称（滴答里的项目名不变）",
          placeholder: name || project.name,
          confirm: "改成",
          value: alias ?? (name || project.name),
          onSubmit: (value) => void this.setPinnedName(project, value === (name || project.name) ? null : value)
        })
    };
    return alias ? [rename, { icon: "rotate-ccw", label: `恢复原名「${name || project.name}」`, run: () => void this.setPinnedName(project, null) }] : [rename];
  }

  /**
   * 项目操作：总览里的项目行（「更多」和右键）与项目详情头部共用。
   * inside 为 true 时是在项目里打开的：不显示「打开」，多出切换项目、刷新。
   */
  private projectActions(project: DidaProject, inside: boolean, rect: DOMRect): ActionMenuSpec {
    const store = this.plugin.store;
    const key = store.projectKey(project.id);
    const count = store.overview?.counts.get(key);
    const snap = store.getProject(key);
    const undone = snap?.tasks.length ?? count?.undone;
    const overdue = snap ? snap.tasks.filter((t) => describeDue(t).state === "overdue").length : count?.overdue;
    const sub = [store.groupName(project.groupId), undone !== undefined ? `${undone} 条待办` : null, overdue ? `${overdue} 条过期` : null].filter(Boolean).join(" · ");
    const { emoji, name } = splitEmoji(project.name);
    const webId = key === INBOX_ID ? (snap?.tasks[0]?.projectId ?? "inbox") : key;
    return {
      head: { emoji: emoji ?? null, title: name || project.name, sub },
      groups: [
        [
          ...(inside ? [] : [{ icon: "arrow-right", label: "打开", run: () => this.showProject(project.id) }]),
          { icon: "plus", label: "新建待办…", run: () => this.plugin.openCreateModal({ projectId: project.id }) },
          { icon: "layout-dashboard", label: "在主窗格打开看板", run: () => void this.plugin.openBoardInMainPane(project.id) },
          // 收件箱本来就是页签，不用置顶
          ...(key === INBOX_ID
            ? []
            : [
                {
                  icon: this.plugin.settings.pinnedProjects.includes(project.id) ? "pin-off" : "pin",
                  label: this.plugin.settings.pinnedProjects.includes(project.id) ? "取消置顶" : "置顶到页签栏",
                  run: () => void this.togglePin(project)
                },
                ...(this.plugin.settings.pinnedProjects.includes(project.id) ? this.pinnedNameActions(project, rect) : [])
              ])
        ],
        // 收件箱是滴答内置的，不能改名也不能归档
        key === INBOX_ID
          ? []
          : [
              { icon: "pencil", label: "编辑项目…", run: () => new ProjectModal(this.plugin, { project }).open() },
              {
                icon: "archive",
                label: "归档项目…",
                danger: true,
                run: () =>
                  void archiveProject(this.plugin, project).then((done) => {
                    if (done && this.projectId === project.id) this.showOverview();
                  })
              }
            ],
        inside
          ? [
              { icon: "folder", label: "切换到其他项目…", run: () => new ProjectSuggestModal(this.app, store, (p) => this.showProject(p.id)).open() },
              { icon: "refresh-cw", label: "刷新此项目", run: () => void this.refresh(true) }
            ]
          : [],
        [{ icon: "external-link", label: "在滴答清单网页版打开", run: () => window.open(`https://dida365.com/webapp/#p/${webId}/tasks`) }]
      ]
    };
  }

  /** 新建项目，建好直接进去。 */
  private openNewProject(groupId: string | null = null): void {
    new ProjectModal(this.plugin, { groupId, onDone: (p) => p && this.showProject(p.id) }).open();
  }

  /** 操作面板同一时间只开一个（任务操作、派送、项目操作共用这个位置）。 */
  private showActions(rect: DOMRect, spec: ActionMenuSpec): void {
    this.actionPop?.close();
    this.actionPop = openActionMenu(this.contentEl.doc, rect, spec);
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

  private renderTodayBoard(body: HTMLElement): void {
    const snap = this.plugin.store.today;
    if (!snap) return;
    const sortByDue = (list: DidaTask[]): DidaTask[] =>
      [...list].sort((a, b) => (a.dueDate ?? a.startDate ?? "").localeCompare(b.dueDate ?? b.startDate ?? ""));
    const todayDate = startOfDay(new Date());
    const today = formatDidaDate(todayDate, true);
    const lanes: LaneSpec[] = [
      {
        key: "overdue",
        name: "已过期",
        cls: "is-overdue",
        tasks: sortByDue(snap.overdue),
        ctx: { showProject: true, card: true },
        emptyText: "没有过期的待办",
        action: snap.overdue.length ? { label: "全部顺延", run: () => void this.rescheduleOverdue(snap.overdue) } : undefined
      },
      {
        key: "today",
        name: "今天",
        cls: "is-today",
        tasks: sortByDue(snap.today),
        ctx: { showProject: true, card: true, hideTodayLabel: true },
        addPrefill: { startDate: today, dueDate: today, isAllDay: true },
        accepts: (t) => t.status !== 2 && describeDue(t).state !== "today",
        onDrop: (t) => this.setDate(t, todayDate)
      }
    ];
    if (this.plugin.settings.completedRange !== "none") {
      lanes.push({
        key: "completed",
        name: "已完成",
        cls: "is-done",
        tasks: snap.completed,
        ctx: { showProject: true, card: true },
        accepts: (t) => t.status !== 2,
        onDrop: (t) => void this.complete(t)
      });
    }
    this.renderLanes(body, lanes);
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
      // 没有分组的任务和滴答一样排在最前面
      const rest = byColumn.get("__none__") ?? [];
      if (rest.length) {
        const { open } = this.renderGroup(body, "col:none", "未分组", rest.length);
        if (open) {
          for (const t of rest) this.renderTask(body, t, ctx);
          this.renderGhost(body, "添加到未分组", { projectId, columnId: null });
        }
      }
      for (const col of snap.columns) {
        const list = byColumn.get(col.id) ?? [];
        const { open, header } = this.renderGroup(body, `col:${col.id}`, col.name, list.length);
        const more = header.createEl("button", { cls: "dida-group-action is-more", attr: { type: "button", "aria-label": `分组「${col.name}」更多操作` } });
        setIcon(more, "more-horizontal");
        const openMenu = (rect: DOMRect): void => this.showActions(rect, this.columnActions(projectId, col, list.length, "list", rect));
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          openMenu(more.getBoundingClientRect());
        });
        header.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          openMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
        });
        if (!open) continue;
        for (const t of list) this.renderTask(body, t, ctx);
        this.renderGhost(body, `添加到${col.name}`, { projectId, columnId: col.id });
      }
      this.renderNewColumn(body, projectId);
      return;
    }

    if (!tasks.length) body.createDiv({ cls: "dida-empty", text: this.filterTag ? "这个标签下没有待办" : "这里暂时没有待办" });
    for (const t of tasks) this.renderTask(body, t, ctx);
    this.renderGhost(body, `添加到${this.plugin.store.projectName(projectId)}`, { projectId });
    this.renderNewColumn(body, projectId);
  }

  /** 分组操作：重命名、在两侧添加、移动、删除。列表视图里说「上方 / 下方」，看板里说「左侧 / 右侧」。 */
  private columnActions(projectId: string, col: DidaColumn, taskCount: number, layout: "list" | "board", rect: DOMRect): ActionMenuSpec {
    const store = this.plugin.store;
    const columns = [...(store.getProject(projectId)?.columns ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    const i = columns.findIndex((c) => c.id === col.id);
    const [before, after, back, forward] = layout === "board" ? ["左侧", "右侧", "左移", "右移"] : ["上方", "下方", "上移", "下移"];
    const fail = (what: string) => (error: unknown) => new Notice(`${what}失败：${this.plugin.describeError(error)}`, 6000);
    const add = (where: "before" | "after"): void => {
      openPrompt(this.contentEl.doc, rect, {
        title: `在「${col.name}」${where === "before" ? before : after}添加分组`,
        placeholder: "新分组名称",
        confirm: "新建分组",
        onSubmit: (name) =>
          void store
            .createColumn(projectId, name, where === "before" ? { before: col.id } : { after: col.id })
            .then(() => new Notice(`已新建分组「${name}」`))
            .catch(fail("新建分组"))
      });
    };
    return {
      groups: [
        [
          {
            icon: "pencil",
            label: "重命名",
            run: () =>
              openPrompt(this.contentEl.doc, rect, {
                title: "重命名分组",
                placeholder: "分组名称",
                confirm: "改名为",
                value: col.name,
                onSubmit: (name) => void store.renameColumn(projectId, col, name).catch(fail("重命名"))
              })
          }
        ],
        [
          { icon: layout === "board" ? "arrow-left-to-line" : "arrow-up-to-line", label: `在${before}添加分组`, run: () => add("before") },
          { icon: layout === "board" ? "arrow-right-to-line" : "arrow-down-to-line", label: `在${after}添加分组`, run: () => add("after") }
        ],
        [
          ...(i > 0 ? [{ icon: layout === "board" ? "arrow-left" : "arrow-up", label: back, run: () => void store.moveColumn(projectId, col, -1).catch(fail("移动")) }] : []),
          ...(i >= 0 && i < columns.length - 1
            ? [{ icon: layout === "board" ? "arrow-right" : "arrow-down", label: forward, run: () => void store.moveColumn(projectId, col, 1).catch(fail("移动")) }]
            : [])
        ],
        [{ icon: "trash-2", label: "删除分组…", danger: true, run: () => void this.deleteColumn(projectId, col, taskCount) }]
      ]
    };
  }

  /** 泳道底部的添加行（照设计稿是一行淡字，点进去就是输入框）：直接输入回车建在这个分组，支持速记（明天 !高 #标签）；建完光标留着继续加。 */
  private renderLaneAdd(parent: HTMLElement, key: string, name: string, prefill: Partial<TaskInput>): HTMLInputElement {
    const box = parent.createDiv({ cls: "dida-lane-add" });
    setIcon(box.createSpan({ cls: "dida-lane-add-icon" }), "plus");
    const input = box.createEl("input", { type: "text", cls: "dida-lane-add-input", attr: { placeholder: `添加到${name}`, "aria-label": `添加任务到${name}` } });
    let busy = false;
    input.addEventListener("keydown", async (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        input.value = "";
        input.blur();
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const parsed = parseQuickAdd(input.value);
      if (!parsed.title || busy) return;
      busy = true;
      input.readOnly = true;
      this.laneAddFocus = key;
      const taskInput: TaskInput = {
        title: parsed.title,
        projectId: prefill.projectId ?? this.currentProjectId(),
        priority: parsed.priority ?? prefill.priority ?? 0,
        tags: parsed.tags,
        content: ""
      };
      if (prefill.columnId) taskInput.columnId = prefill.columnId;
      if (parsed.date) {
        const when = formatDidaDate(parsed.date, parsed.allDay);
        taskInput.startDate = when;
        taskInput.dueDate = when;
        taskInput.isAllDay = parsed.allDay;
      } else if (prefill.dueDate) {
        // 今天看板的「今天」泳道：没写日期就排到今天
        taskInput.startDate = prefill.startDate ?? prefill.dueDate;
        taskInput.dueDate = prefill.dueDate;
        taskInput.isAllDay = prefill.isAllDay ?? true;
      }
      try {
        await this.plugin.store.createTask(taskInput);
        input.value = "";
      } catch (error) {
        new Notice(`添加失败：${this.plugin.describeError(error)}`, 6000);
      } finally {
        busy = false;
        input.readOnly = false;
        input.focus();
      }
    });
    input.addEventListener("blur", () => {
      if (!busy && this.laneAddFocus === key) this.laneAddFocus = null;
    });
    if (this.laneAddFocus === key) window.setTimeout(() => input.focus(), 0);
    return input;
  }

  /** 「+ 新建分组」：点开变成输入框，回车建好，Esc 或留空失焦就收回去。 */
  private renderNewColumn(parent: HTMLElement, projectId: string, cls = ""): void {
    const box = parent.createDiv({ cls: `dida-new-column ${cls}`.trim() });
    const idle = (): void => {
      box.empty();
      box.removeClass("is-editing");
      const ghost = box.createEl("button", { cls: "dida-new-column-btn", attr: { type: "button" } });
      setIcon(ghost.createSpan(), "plus");
      ghost.createSpan({ text: "新建分组" });
      ghost.addEventListener("click", edit);
    };
    const edit = (): void => {
      box.empty();
      box.addClass("is-editing");
      const input = box.createEl("input", { type: "text", cls: "dida-new-column-input", attr: { placeholder: "分组名称，回车创建", "aria-label": "新分组名称" } });
      let busy = false;
      const submit = async (): Promise<void> => {
        const name = input.value.trim();
        if (!name || busy) return;
        busy = true;
        input.disabled = true;
        try {
          await this.plugin.store.createColumn(projectId, name);
          new Notice(`已新建分组「${name}」`);
        } catch (error) {
          new Notice(`新建分组失败：${this.plugin.describeError(error)}`, 6000);
          busy = false;
          input.disabled = false;
          input.focus();
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          idle();
        }
      });
      input.addEventListener("blur", () => {
        if (!input.value.trim() && !busy) idle();
      });
      window.setTimeout(() => input.focus(), 0);
    };
    idle();
  }

  /**
   * 删除分组：滴答的 MCP 没有删分组的工具，只能到网页版删。
   * 先说清楚，再在浏览器打开这个项目；分组里还有任务时一并提醒。
   */
  private async deleteColumn(projectId: string, col: DidaColumn, taskCount: number): Promise<void> {
    const tasksNote = taskCount ? `\n\n这个分组里还有 ${taskCount} 条待办，删除前记得先移走。` : "";
    const ok = await ConfirmModal.ask(
      this.app,
      `删除分组「${col.name}」`,
      `滴答清单开放的接口还不支持删除分组，插件这边删不了。\n\n点「去网页版」会在浏览器打开这个项目，在分组名右侧的「…」里删除。${tasksNote}`,
      "去网页版"
    );
    if (!ok) return;
    const key = this.plugin.store.projectKey(projectId);
    const id = key === INBOX_ID ? (this.plugin.store.getProject(key)?.tasks[0]?.projectId ?? "inbox") : key;
    window.open(`https://dida365.com/webapp/#p/${id}/tasks`);
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
    const ctx: TaskRenderContext = { showProject: false, columns: snap.columns, card: true };
    const lanes: LaneSpec[] = snap.columns.map((col) => ({
      key: col.id,
      name: col.name,
      tasks: byColumn.get(col.id) ?? [],
      ctx,
      addPrefill: { projectId, columnId: col.id },
      accepts: (t: DidaTask) => t.columnId !== col.id,
      onDrop: (t: DidaTask) => void this.moveToColumn(t, col),
      menu: (rect: DOMRect) => this.showActions(rect, this.columnActions(projectId, col, (byColumn.get(col.id) ?? []).length, "board", rect))
    }));
    const rest = byColumn.get("__none__") ?? [];
    if (rest.length) lanes.unshift({ key: "__none__", name: "未分组", tasks: rest, ctx, addPrefill: { projectId, columnId: null } });
    const board = this.renderLanes(body, lanes);
    this.renderNewColumn(board, projectId, "is-lane");
  }

  /** 横向泳道 + 顶部跳转胶囊；接受拖放的泳道在卡片拖过来时高亮。 */
  private renderLanes(body: HTMLElement, specs: LaneSpec[]): HTMLElement {
    body.addClass("is-board");
    const jump = body.createDiv({ cls: "dida-board-jump" });
    const lanes = body.createDiv({ cls: "dida-board" });

    for (const spec of specs) {
      const lane = lanes.createDiv({ cls: `dida-lane ${spec.cls ?? ""}`.trim() });
      const head = lane.createDiv({ cls: "dida-lane-head" });
      head.createSpan({ cls: "dida-lane-name", text: spec.name });
      head.createSpan({ cls: "dida-group-count", text: String(spec.tasks.length) });
      head.createSpan({ cls: "dida-group-spacer" });
      if (spec.action) {
        const act = head.createEl("button", { cls: "dida-lane-action", text: spec.action.label, attr: { type: "button" } });
        const run = spec.action.run;
        act.addEventListener("click", () => run());
      }
      const prefill = spec.addPrefill;
      const menu = spec.menu;
      // 标题右侧：「+」把光标放进泳道底部的添加行；「···」悬停才出现
      let addInput: HTMLInputElement | null = null;
      if (prefill) this.iconButton(head, "plus", `添加到${spec.name}`, () => addInput?.focus(), "is-small");
      if (menu) {
        const more = this.iconButton(head, "more-horizontal", `分组「${spec.name}」更多操作`, () => menu(more.getBoundingClientRect()), "is-small is-more");
        head.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          menu(new DOMRect(e.clientX, e.clientY, 0, 0));
        });
      }

      const cards = lane.createDiv({ cls: "dida-lane-cards" });
      cards.createDiv({ cls: "dida-lane-drop" });
      // 父任务也在这条泳道时，子任务收进父任务卡片里，不单独占一张卡
      const ids = new Set(spec.tasks.map((t) => t.id));
      const tops = spec.tasks.filter((t) => !(t.parentId && ids.has(t.parentId)));
      for (const t of tops) this.renderTask(cards, t, spec.ctx);
      if (prefill) addInput = this.renderLaneAdd(cards, spec.key, spec.name, prefill);
      else if (!spec.tasks.length) cards.createDiv({ cls: "dida-lane-empty", text: spec.emptyText ?? "暂无待办" });

      const accepts = spec.accepts;
      const onDrop = spec.onDrop;
      if (accepts && onDrop) {
        lane.addEventListener("dragover", (e) => {
          if (!this.dragging || !accepts(this.dragging)) return;
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
          if (task && accepts(task)) onDrop(task);
        });
      }

      const pill = jump.createEl("button", { cls: "dida-board-jump-pill", attr: { type: "button" } });
      pill.createSpan({ text: spec.name });
      pill.createSpan({ cls: "dida-group-count", text: String(spec.tasks.length) });
      pill.addEventListener("click", () => {
        lane.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
        jump.querySelectorAll(".dida-board-jump-pill").forEach((el) => el.removeClass("is-active"));
        pill.addClass("is-active");
      });
    }
    jump.querySelector(".dida-board-jump-pill")?.addClass("is-active");
    return lanes;
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
    if (task.parentId && !ctx.card && !ctx.nested) row.addClass("is-child");
    if (task.status === 2) row.addClass("is-done");
    // 父任务卡片里的子任务单独记展开状态，展开子任务时父任务保持展开
    const expanded = ctx.nested ? this.expandedChild === task.id : this.expanded === task.id;
    if (expanded) row.addClass("is-expanded");
    if (ctx.nested) row.addClass("is-nested");
    if (task.status !== 2) this.visibleTasks.push(task);
    if (this.selecting) {
      row.addClass("is-selecting");
      row.toggleClass("is-selected", this.selected.has(task.id));
    }
    // 多选：捕获阶段先拦下点击，免得勾掉、展开或开菜单；父任务卡片里的子任务行只认它自己
    row.addEventListener(
      "click",
      (e) => {
        if (!this.selecting && !(e.metaKey || e.ctrlKey)) return;
        if ((e.target as HTMLElement).closest(".dida-task") !== row || task.status === 2) return;
        e.preventDefault();
        e.stopPropagation();
        this.toggleSelected(task);
      },
      true
    );

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
      if (ctx.nested) this.expandedChild = expanded ? null : task.id;
      else {
        this.expanded = expanded ? null : task.id;
        this.expandedChild = null;
      }
      this.render();
    });

    const meta = body.createDiv({ cls: "dida-task-meta" });
    const due = describeDue(task);
    if (due.label && !(ctx.hideTodayLabel && due.state === "today" && task.isAllDay !== false)) {
      meta.createSpan({ cls: `dida-due is-${due.state}`, text: due.label });
    }
    const repeat = describeRepeat(task.repeatFlag);
    if (repeat) {
      const r = meta.createSpan({ cls: "dida-repeat", attr: { "aria-label": repeat, title: repeat } });
      setIcon(r, "repeat");
    }
    // 优先级看勾选框的圈（高红、中深灰），属性行不再单放「高 / 中」
    // 子任务进度：只数还存在的子任务（删掉的子任务 id 会残留在 childIds 里，见 store.subtaskProgress）
    const { done, total } = this.plugin.store.subtaskProgress(task);
    if (total) {
      const sub = meta.createSpan({ cls: "dida-subcount", attr: { "aria-label": `子任务完成 ${done} / ${total}` } });
      setIcon(sub.createSpan({ cls: "dida-subcount-icon" }), "list-tree");
      sub.createSpan({ text: `${done}/${total}` });
      sub.toggleClass("is-done", done === total);
      // 点进度直接展开父任务，看到子任务列表
      sub.addEventListener("click", (e) => {
        e.stopPropagation();
        this.expanded = expanded && !ctx.nested ? null : task.id;
        this.expandedChild = null;
        this.render();
      });
    }
    // 清单型任务的检查项进度，点一下展开看全部检查项
    const items = task.items ?? [];
    if (items.length) {
      const checked = items.filter((i) => i.status === 1).length;
      const badge = meta.createSpan({ cls: "dida-subcount", attr: { "aria-label": `检查项完成 ${checked} / ${items.length}` } });
      setIcon(badge.createSpan({ cls: "dida-subcount-icon" }), "list-checks");
      badge.createSpan({ text: `${checked}/${items.length}` });
      badge.toggleClass("is-done", checked === items.length);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        title.click();
      });
    }
    if (ctx.showProject) meta.createSpan({ cls: "dida-task-project", text: this.plugin.store.projectName(task.projectId) });
    if (task.status === 2 && task.completedTime) {
      const done = new Date(task.completedTime);
      if (!Number.isNaN(done.getTime())) meta.createSpan({ text: `${String(done.getHours()).padStart(2, "0")}:${String(done.getMinutes()).padStart(2, "0")} 完成` });
    }
    for (const tag of task.tags ?? []) {
      if (ctx.columns && this.filterTag === tag) continue;
      if (ctx.hideTag === tag) continue;
      const chip = meta.createSpan({ cls: "dida-tag", text: this.plugin.tagLabel(tag) });
      if (tag === this.plugin.settings.aiTag) chip.addClass("is-queue");
      else this.plugin.applyTagColor(chip, tag);
    }
    const text = taskBody(task);
    const linked = boundNotePath(text);
    if (linked) {
      const name = linked.split("/").pop() ?? linked;
      const btn = meta.createEl("button", { cls: "dida-note-btn", attr: { type: "button", "aria-label": `打开关联笔记：${name}`, title: linked } });
      setIcon(btn, "link");
      if (/^正文：\[/m.test(text)) btn.addClass("is-body");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.app.workspace.openLinkText(linked, "", false);
      });
    } else if (!ctx.showProject && /^正文：待建/m.test(text)) {
      meta.createSpan({ text: "正文待建" });
    }

    // 右上角悬停只留「⋯」；派给 AI、笔记、日期、编辑这几个常用的放在展开后的底部一排
    const actions = row.createDiv({ cls: "dida-task-actions" });
    const more = this.iconButton(actions, "more-horizontal", "更多", () => this.openTaskActions(task, ctx, more.getBoundingClientRect()));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // 子任务行嵌在父任务卡片里，别让右键冒泡到父任务再开一次
      e.stopPropagation();
      this.openTaskActions(task, ctx, new DOMRect(e.clientX, e.clientY, 0, 0));
    });

    if (expanded) this.renderDetails(row, task, ctx);
  }

  /** 父任务卡片里的子任务列表：每行就是完整的任务行，勾选、展开、编辑、右键都和普通任务一样。 */
  private renderSubtaskList(details: HTMLElement, card: HTMLElement, task: DidaTask, ctx: TaskRenderContext): void {
    const children = this.plugin.store.childrenOf(task.id);
    if (!children.length) return;
    const list = details.createDiv({ cls: "dida-subtasks" });
    for (const child of children) this.renderTask(list, child, { ...ctx, card: false, nested: true });
    // 在子任务上按下时暂停父卡片的拖拽，免得想选文字或点子任务却拖走了整张卡
    list.addEventListener("mousedown", () => (card.draggable = false));
    const restore = (): void => {
      card.draggable = task.status !== 2;
    };
    list.addEventListener("mouseup", restore);
    list.addEventListener("mouseleave", restore);
  }

  /**
   * 展开卡片里的「添加子任务」：回车建一条，输入框留着继续加。
   * 子任务本身就是普通任务，建好后排在父任务正下方，完成、编辑、删除和其他任务一样。
   */
  private renderSubtaskInput(parent: HTMLElement, task: DidaTask): void {
    const box = parent.createDiv({ cls: "dida-subtask-add" });
    setIcon(box.createSpan({ cls: "dida-subtask-add-icon" }), "corner-down-right");
    const input = box.createEl("input", { type: "text", cls: "dida-subtask-input", attr: { placeholder: "添加子任务，回车创建", "aria-label": `给「${task.title}」添加子任务` } });
    let busy = false;
    input.addEventListener("keydown", async (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        this.subtaskFocus = null;
        input.blur();
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const title = input.value.trim();
      if (!title || busy) return;
      busy = true;
      input.readOnly = true;
      this.subtaskFocus = task.id;
      try {
        await this.plugin.store.createTask({
          title,
          projectId: task.projectId,
          columnId: task.columnId,
          parentId: task.id,
          priority: 0,
          tags: [],
          content: ""
        });
        input.value = "";
      } catch (error) {
        new Notice(`添加子任务失败：${this.plugin.describeError(error)}`, 6000);
      } finally {
        busy = false;
        input.readOnly = false;
        input.focus();
      }
    });
    // 失焦（点去别处）就不再在重画时抢焦点；提交中的失焦是禁用输入框引起的，不算
    input.addEventListener("blur", () => {
      if (!busy && this.subtaskFocus === task.id) this.subtaskFocus = null;
    });
    if (this.subtaskFocus === task.id) window.setTimeout(() => input.focus(), 0);
  }

  private renderDetails(row: HTMLElement, task: DidaTask, ctx: TaskRenderContext): void {
    const details = row.createDiv({ cls: "dida-task-details" });
    const body = taskBody(task);
    if (body.trim()) {
      // 正文里的任务列表勾一下就改正文存回滴答
      renderTaskMarkdown(this.app, body, details.createDiv(), this, (next) =>
        void this.plugin.store.updateTask(task, { content: next }).catch((error: unknown) => new Notice(`更新正文失败：${this.plugin.describeError(error)}`))
      );
    }
    if (task.items?.length) this.renderChecklist(details, task, task.items);
    // 看板卡片里子任务收进父任务，展开时在这里列出来；列表视图里子任务本来就缩进排在父任务下面
    if (ctx.card && !ctx.nested) this.renderSubtaskList(details, row, task, ctx);
    if (task.status !== 2 && !task.parentId) this.renderSubtaskInput(details, task);
    this.renderQuickActions(details, task);
  }

  /** 展开后底部一排常用动作：派给 AI、打开 / 创建笔记、设置日期时间、编辑；其余的在「⋯」里 */
  private renderQuickActions(parent: HTMLElement, task: DidaTask): void {
    const bar = parent.createDiv({ cls: "dida-task-quick" });
    if (task.status !== 2) {
      const queued = isQueued(task, this.plugin.settings.aiTag);
      const target = targetInfo(this.plugin.settings.aiTarget).label;
      const bot = this.iconButton(bar, "bot", `${queued ? "再派给" : "派给"} ${target}（右键换一个）`, () => void this.plugin.dispatchTask(task), queued ? "is-accent" : "");
      bot.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openDispatchPicker(task, bot.getBoundingClientRect());
      });
    }
    const note = boundNotePath(taskBody(task));
    if (note) this.iconButton(bar, "file-text", `打开笔记：${note}`, () => void this.app.workspace.openLinkText(note, "", false));
    else this.iconButton(bar, "file-plus", "创建笔记并绑定到这条待办", () => void this.plugin.createNoteForTask(task).catch((error: unknown) => new Notice(`建笔记失败：${this.plugin.describeError(error)}`, 6000)));
    if (task.status !== 2) {
      const date = this.iconButton(bar, "calendar-clock", "设置日期和时间", () => {
        this.actionPop?.close();
        const start = parseDidaDate(task.startDate ?? task.dueDate);
        this.actionPop = openDatePicker(this.contentEl.doc, date.getBoundingClientRect(), { date: start, allDay: task.isAllDay !== false }, (next) =>
          this.setDate(task, next.date, next.allDay)
        );
      });
    }
    this.iconButton(bar, "pencil", "编辑", () => this.plugin.openEditModal(task));
  }

  /** 清单型任务的检查项：勾一下就整组写回滴答（接口只认整组 items） */
  private renderChecklist(parent: HTMLElement, task: DidaTask, items: ChecklistItem[]): void {
    const list = parent.createDiv({ cls: "dida-checklist" });
    for (const item of items) {
      const line = list.createEl("label", { cls: "dida-checklist-item" });
      line.toggleClass("is-done", item.status === 1);
      const box = line.createEl("input", { type: "checkbox", cls: "dida-checklist-box" });
      box.checked = item.status === 1;
      box.disabled = task.status === 2;
      line.createSpan({ cls: "dida-checklist-title", text: item.title || "（无标题）" });
      box.addEventListener("change", () => {
        line.toggleClass("is-done", box.checked);
        const next = items.map((i): ChecklistItem => (i.id === item.id ? { ...i, status: box.checked ? 1 : 0 } : i));
        void this.plugin.store.updateTask(task, { items: next }).catch((error: unknown) => {
          box.checked = !box.checked;
          line.toggleClass("is-done", box.checked);
          new Notice(`更新检查项失败：${this.plugin.describeError(error)}`);
        });
      });
    }
  }

  /** allDay 不传就只换日子，原来的时刻和时间段都留着（见 rescheduleDates） */
  private setDate(task: DidaTask, d: Date | null, allDay?: boolean): void {
    void this.plugin.store
      .updateTask(task, rescheduleDates(task, d, allDay))
      .catch((error: unknown) => new Notice(`改期失败：${this.plugin.describeError(error)}`));
  }

  /** 「派给哪个 AI」面板，同一时间只开一个。 */
  private openDispatchPicker(task: DidaTask, rect: DOMRect): void {
    this.actionPop?.close();
    this.actionPop = openDispatchPicker(this.plugin, task, this.contentEl.doc, rect);
  }

  /**
   * 任务操作面板（「更多」按钮和右键共用），同一时间只开一个（和派送面板共用一个位置）。
   * 今天、搜索这些跨项目的视图没带分组，就从缓存里取；没缓存过的项目先加载，到了再重画面板。
   */
  private openTaskActions(task: DidaTask, ctx: TaskRenderContext, anchor: DOMRect): void {
    const store = this.plugin.store;
    const columns = (): DidaColumn[] => ctx.columns ?? store.getProject(task.projectId)?.columns ?? [];
    if (!ctx.columns && !store.getProject(task.projectId)) {
      void store.loadProject(task.projectId).then(() => this.actionPop?.refresh()).catch(() => null);
    }
    const fail = (error: unknown): void => {
      new Notice(this.plugin.describeError(error));
    };
    this.actionPop?.close();
    this.actionPop = openTaskActions(
      task,
      {
        columns,
        linkedNote: boundNotePath(taskBody(task)),
        dispatch: (rect) => this.openDispatchPicker(task, rect),
        edit: () => this.plugin.openEditModal(task),
        openNote: (path) => void this.app.workspace.openLinkText(path, "", false),
        createNote: () => void this.plugin.createNoteForTask(task).catch(fail),
        openWeb: () => window.open(taskWebUrl(task)),
        setDate: (d, allDay) => this.setDate(task, d, allDay),
        setPriority: (p) => void store.updateTask(task, { priority: p }).catch(fail),
        // 重复要有起始日：没日子的任务设重复时顺便定在今天
        setRepeat: (rule) =>
          void store
            .updateTask(task, { repeatFlag: rule, ...(rule && !task.startDate && !task.dueDate ? rescheduleDates(task, new Date(), true) : {}) })
            .catch(fail),
        moveToColumn: (col) => void this.moveToColumn(task, col),
        moveToProject: () =>
          new ProjectSuggestModal(
            this.app,
            store,
            (p) => void store.moveTask(task, p.id).then(() => new Notice(`已移到「${p.name}」`)).catch(fail),
            [store.projectKey(task.projectId)]
          ).open(),
        remove: () => void this.remove(task),
        addSubtask: () => {
          this.expanded = task.id;
          this.subtaskFocus = task.id;
          this.render();
        },
        parentCandidates: () =>
          (store.getProject(task.projectId)?.tasks ?? []).filter((t) => t.id !== task.id && !t.parentId && t.status !== 2),
        setParent: (parentId) =>
          void store
            .updateTask(task, { parentId })
            .then(() => new Notice(parentId ? `已挂到「${store.taskTitle(parentId) ?? "父任务"}」下` : "已转成独立任务"))
            .catch(fail)
      },
      this.contentEl.doc,
      anchor
    );
  }


  private async moveToColumn(task: DidaTask, col: DidaColumn): Promise<void> {
    try {
      await this.plugin.store.updateTask(task, { columnId: col.id });
      new Notice(`已移到「${col.name}」`);
    } catch (error) {
      new Notice(`移动失败：${this.plugin.describeError(error)}`);
    }
  }

  // ---------- 多选与批量 ----------

  private enterSelecting(): void {
    this.selecting = true;
    this.expanded = null;
    this.render();
  }

  private exitSelecting(): void {
    this.selecting = false;
    this.selected.clear();
    this.render();
  }

  private toggleSelected(task: DidaTask): void {
    if (!this.selecting) this.selecting = true;
    if (this.selected.has(task.id)) this.selected.delete(task.id);
    else this.selected.set(task.id, task);
    this.render();
  }

  /** 底部批量操作栏：已选几条 · 全选 · 完成 / 日期 / 优先级 / 移到 / 删除 · 退出 */
  private renderBatchBar(root: HTMLElement): void {
    const store = this.plugin.store;
    const tasks = [...this.selected.values()];
    const bar = root.createDiv({ cls: "dida-batch" });
    bar.createSpan({ cls: "dida-batch-count", text: tasks.length ? `已选 ${tasks.length} 条` : "点任务选择，Esc 退出" });
    const allOn = this.visibleTasks.length > 0 && this.visibleTasks.every((t) => this.selected.has(t.id));
    const link = bar.createEl("button", { cls: "dida-batch-link", text: allOn ? "全不选" : "全选", attr: { type: "button" } });
    link.addEventListener("click", () => {
      if (allOn) this.selected.clear();
      else for (const t of this.visibleTasks) this.selected.set(t.id, t);
      this.render();
    });
    const actions = bar.createDiv({ cls: "dida-batch-actions" });
    const fail = (what: string) => (error: unknown) => new Notice(`${what}失败：${this.plugin.describeError(error)}`, 6000);
    const finish = (text: string): void => {
      new Notice(text);
      this.exitSelecting();
    };
    const act = (icon: string, label: string, run: (rect: DOMRect) => void, cls = ""): void => {
      const b = this.iconButton(actions, icon, label, (e) => run((e.currentTarget as HTMLElement).getBoundingClientRect()), cls);
      if (!tasks.length) b.setAttribute("disabled", "");
    };
    act("check", "完成", () => void Promise.all(tasks.map((t) => store.completeTask(t))).then(() => finish(`已完成 ${tasks.length} 条`)).catch(fail("完成")));
    act("calendar", "改日期", (rect) => {
      this.actionPop?.close();
      this.actionPop = openDatePicker(this.contentEl.doc, rect, { date: null, allDay: true }, (next) => {
        // 只选了日子就只换日子，各自的时刻和时间段留着；选了时刻就统一改成那个时刻
        void store
          .batchUpdate(tasks, (t) => rescheduleDates(t, next.date, next.date && !next.allDay ? false : undefined))
          .then(() => finish(next.date ? `已改 ${tasks.length} 条的日期` : `已清除 ${tasks.length} 条的日期`))
          .catch(fail("改日期"));
      });
    });
    act("flag", "优先级", (rect) =>
      this.showActions(rect, {
        groups: [
          [...PRIORITIES].reverse().map((p) => ({
            icon: "flag",
            label: p ? `${PRIORITY_LABEL[p]}优先级` : "无优先级",
            run: () => void store.batchUpdate(tasks, () => ({ priority: p })).then(() => finish(`已改 ${tasks.length} 条的优先级`)).catch(fail("改优先级"))
          }))
        ]
      })
    );
    act("folder-input", "移到项目", () =>
      new ProjectSuggestModal(this.app, store, (p) =>
        void Promise.all(tasks.filter((t) => store.projectKey(t.projectId) !== store.projectKey(p.id)).map((t) => store.moveTask(t, p.id)))
          .then(() => finish(`已移到「${p.name}」`))
          .catch(fail("移动"))
      ).open()
    );
    act("trash-2", "删除", () => void Promise.all(tasks.map((t) => store.deleteTask(t))).then(() => finish(`已删除 ${tasks.length} 条`)).catch(fail("删除")), "is-danger");
    const close = bar.createEl("button", { cls: "dida-batch-link", text: "退出", attr: { type: "button" } });
    close.addEventListener("click", () => this.exitSelecting());
  }

  private async complete(task: DidaTask): Promise<void> {
    try {
      await this.plugin.store.completeTask(task);
    } catch (error) {
      new Notice(`完成失败：${this.plugin.describeError(error)}`, 6000);
    }
  }

  private async remove(task: DidaTask): Promise<void> {
    try {
      await this.plugin.store.deleteTask(task);
      new Notice(`已删除「${task.title}」`);
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
