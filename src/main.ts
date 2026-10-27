import { FileSystemAdapter, Notice, Plugin, type Editor, type MarkdownFileInfo, type MarkdownView, type Menu, type TFile } from "obsidian";
import { DidaApi } from "./dida/api.ts";
import { formatDidaDate, startOfDay } from "./dida/dates.ts";
import { appendNoteLink } from "./dida/deeplink.ts";
import type { DidaTask, TaskInput } from "./dida/types.ts";
import { McpAuthError, McpClient } from "./mcp/client.ts";
import { loginWithBrowser, refreshTokens, tokensExpired } from "./mcp/oauth.ts";
import { DEFAULT_SETTINGS, DidaSettingTab, type DidaSettings } from "./settings.ts";
import { sendToMakerPilot } from "./dispatch/makerpilot.ts";
import { buildDispatchPrompt, isQueued, withQueueTag, withoutQueueTag } from "./dispatch/prompt.ts";
import { DidaStore } from "./store.ts";
import { renderDidaBlock } from "./view/codeblock.ts";
import { DidaPanelView, VIEW_TYPE_DIDA } from "./view/panelView.ts";
import { ProjectSuggestModal } from "./view/projectSuggest.ts";
import { TaskModal, type TaskModalOptions } from "./view/taskModal.ts";
import { TaskSuggestModal } from "./view/taskSuggest.ts";
import { ReviewModal } from "./view/reviewModal.ts";

export interface NoteRef {
  vault: string;
  path: string;
}

export default class DidaPanelPlugin extends Plugin {
  settings: DidaSettings = DEFAULT_SETTINGS;
  client!: McpClient;
  api!: DidaApi;
  store!: DidaStore;
  private loggingIn = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.client = new McpClient({
      endpoint: () => this.settings.endpoint,
      getToken: () => this.accessToken(),
      clientInfo: { name: "obsidian-dida-panel", version: this.manifest.version }
    });
    this.api = new DidaApi(this.client);
    this.store = new DidaStore(this.api, {
      hideSeparators: () => this.settings.hideSeparators,
      completedRange: () => this.settings.completedRange
    });

    this.registerView(VIEW_TYPE_DIDA, (leaf) => new DidaPanelView(leaf, this));
    this.addRibbonIcon("check-circle", "滴答清单任务面板", () => void this.activateView());
    this.addSettingTab(new DidaSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor("dida", (source, el, ctx) => renderDidaBlock(this, source, el, ctx));
    this.registerCommands();
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => this.onEditorMenu(menu, editor, info)));

    this.registerInterval(window.setInterval(() => void this.tick(), 60_000));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) void this.activateView();
    });
  }

  onunload(): void {
    // registerView / registerInterval / registerEvent 由 Obsidian 自动清理
  }

  // ---------- 设置 ----------

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<DidaSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  // ---------- 登录态 ----------

  accessToken(): string | null {
    if (this.settings.manualToken) return this.settings.manualToken;
    return this.settings.tokens?.accessToken ?? null;
  }

  isLoggedIn(): boolean {
    return !!this.accessToken();
  }

  connectionStatus(): string {
    if (this.settings.manualToken) return "使用手动填写的访问令牌";
    const tokens = this.settings.tokens;
    if (!tokens) return "尚未登录";
    if (tokensExpired(tokens)) return tokens.refreshToken ? "令牌已过期，下次请求时自动续期" : "令牌已过期，需要重新登录";
    const expires = tokens.expiresAt ? `，${new Date(tokens.expiresAt).toLocaleDateString()} 到期` : "";
    return `已登录${expires}`;
  }

  async login(): Promise<void> {
    if (this.loggingIn) return;
    this.loggingIn = true;
    const notice = new Notice("准备登录滴答清单…", 0);
    try {
      const tokens = await loginWithBrowser(this.settings.endpoint, (url) => window.open(url), (status) => notice.setMessage(status));
      this.settings.tokens = tokens;
      this.settings.manualToken = "";
      await this.saveSettings();
      this.client.reset();
      this.store.invalidateAll();
      notice.hide();
      new Notice("滴答清单已登录");
    } catch (error) {
      notice.hide();
      new Notice(`登录失败：${this.describeError(error)}`, 8000);
      throw error;
    } finally {
      this.loggingIn = false;
    }
  }

  async logout(): Promise<void> {
    this.settings.tokens = null;
    this.settings.manualToken = "";
    await this.saveSettings();
    this.client.reset();
    this.store.invalidateAll();
    new Notice("已退出滴答清单");
  }

  /** 每分钟：令牌快过期就续期；面板可见且到了刷新间隔就重新拉。 */
  private async tick(): Promise<void> {
    const tokens = this.settings.tokens;
    if (tokens && !this.settings.manualToken && tokensExpired(tokens) && tokens.refreshToken) {
      try {
        const next = await refreshTokens(tokens);
        if (next) {
          this.settings.tokens = next;
          await this.saveSettings();
          this.client.reset();
        }
      } catch {
        // 续期失败就等用户下次操作时重新登录
      }
    }
    const minutes = this.settings.refreshMinutes;
    if (!minutes) return;
    if (Date.now() - this.store.lastRefreshAt < minutes * 60_000) return;
    const view = this.panelView();
    if (view && (view.containerEl.isShown() || view.containerEl.offsetParent !== null)) await view.refresh(true).catch(() => null);
  }

  // ---------- 面板 ----------

  panelView(): DidaPanelView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIDA)[0];
    return leaf?.view instanceof DidaPanelView ? leaf.view : null;
  }

  async activateView(): Promise<DidaPanelView | null> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIDA)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (!right) return null;
      await right.setViewState({ type: VIEW_TYPE_DIDA, active: true });
      leaf = right;
    }
    void this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof DidaPanelView ? leaf.view : null;
  }

  /** 在主窗格新开一个页签，用看板模式显示该项目。 */
  async openBoardInMainPane(projectId: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_DIDA, active: true, state: { tab: "project", projectId, mode: "board" } });
    void this.app.workspace.revealLeaf(leaf);
  }

  /** 任务体检：默认审面板当前所在的项目或收件箱，在今天 / 总览时审全部待办。 */
  openReview(): void {
    if (!this.isLoggedIn()) {
      new Notice("先在设置里登录滴答清单");
      return;
    }
    new ReviewModal(this, this.panelView()?.reviewScope() ?? null).open();
  }

  // ---------- 派给 AI ----------

  /** 打队列标签 + 拼指令 + 拉起 MakerPilot 填好。MakerPilot 不在时把指令复制到剪贴板。 */
  async dispatchTask(task: DidaTask, openMakerPilot = true): Promise<void> {
    const tag = this.settings.aiTag;
    let current = task;
    if (!isQueued(task, tag)) {
      try {
        current = await this.store.updateTask(task, { tags: withQueueTag(task.tags, tag) });
      } catch (error) {
        new Notice(`打标签失败：${this.describeError(error)}`, 6000);
        return;
      }
    }
    if (!openMakerPilot) {
      new Notice(`已进 AI 队列：「${task.title}」`);
      return;
    }
    const snap = this.store.getProject(task.projectId);
    const prompt = buildDispatchPrompt(current, {
      projectName: this.store.projectName(task.projectId),
      columnName: snap?.columns.find((c) => c.id === task.columnId)?.name ?? task.columnName ?? null,
      tagLabels: (current.tags ?? []).map((t) => this.tagLabel(t)),
      queueTag: tag,
      vaultName: this.settings.vaultName || this.app.vault.getName(),
      template: this.settings.aiPromptTemplate
    });
    const result = await sendToMakerPilot(this.app, prompt, this.settings.aiNewConversation);
    if (result === "sent") {
      new Notice("已派给 MakerPilot，确认一下指令再回车");
      return;
    }
    await navigator.clipboard.writeText(prompt);
    new Notice(result === "no-plugin" ? "MakerPilot 未启用，指令已复制到剪贴板" : "MakerPilot 还没准备好，指令已复制到剪贴板", 6000);
  }

  async undispatchTask(task: DidaTask): Promise<void> {
    try {
      await this.store.updateTask(task, { tags: withoutQueueTag(task.tags, this.settings.aiTag) });
      new Notice(`已从 AI 队列移除：「${task.title}」`);
    } catch (error) {
      new Notice(`移除失败：${this.describeError(error)}`, 6000);
    }
  }

  // ---------- 笔记联动 ----------

  /** vault 在磁盘上的绝对路径（桌面端）。 */
  vaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  currentNote(): NoteRef | null {
    const file = this.app.workspace.getActiveFile();
    return file ? this.noteRef(file) : null;
  }

  noteRef(file: TFile): NoteRef {
    return { vault: this.settings.vaultName || this.app.vault.getName(), path: file.path };
  }

  tagLabel(name: string): string {
    return this.store.tagByName(name)?.label ?? name;
  }

  applyTagColor(el: HTMLElement, name: string): void {
    const color = this.store.tagByName(name)?.color;
    if (!color) return;
    el.style.background = `color-mix(in srgb, ${color} 16%, var(--background-primary))`;
    el.style.color = `color-mix(in srgb, ${color} 45%, var(--text-normal))`;
  }

  openCreateModal(prefill: Partial<TaskInput> = {}, extra: Omit<TaskModalOptions, "task" | "prefill"> = {}): void {
    new TaskModal(this, { prefill: { ...prefill, content: prefill.content ?? "" }, ...extra }).open();
  }

  openEditModal(task: DidaTask, onDone?: (task: DidaTask) => void): void {
    new TaskModal(this, { task, onDone }).open();
  }

  describeError(error: unknown): string {
    if (error instanceof McpAuthError) return "尚未登录滴答清单，或登录已失效";
    if (error instanceof Error) return error.message;
    return String(error);
  }

  // ---------- 命令与菜单 ----------

  private registerCommands(): void {
    this.addCommand({ id: "open-panel", name: "打开任务面板", callback: () => void this.activateView() });
    this.addCommand({ id: "quick-add", name: "快速添加待办", callback: () => this.openCreateModal() });
    this.addCommand({
      id: "create-from-selection",
      name: "从选中文本创建待办",
      editorCheckCallback: (checking, editor) => {
        const text = editor.getSelection().trim();
        if (!text) return false;
        if (!checking) this.createFromText(text, false);
        return true;
      }
    });
    this.addCommand({
      id: "link-note-to-task",
      name: "把当前笔记关联到已有待办",
      checkCallback: (checking) => {
        const note = this.currentNote();
        if (!note) return false;
        if (!checking) this.linkNoteToTask(note);
        return true;
      }
    });
    this.addCommand({
      id: "insert-task-block",
      name: "在光标处插入任务块",
      editorCallback: (editor) => {
        const project = this.store.projectById(this.settings.lastProjectId)?.name ?? "项目名";
        editor.replaceSelection(`\`\`\`dida\nproject: ${project}\ncolumn: \n\`\`\`\n`);
      }
    });
    this.addCommand({
      id: "switch-project",
      name: "切换到项目…",
      callback: () => {
        void this.activateView().then(async (view) => {
          if (!view) return;
          await this.store.loadProjects();
          new ProjectSuggestModal(this.app, this.store, (p) => view.showProject(p.id)).open();
        });
      }
    });
    this.addCommand({
      id: "open-ai-queue",
      name: "打开 AI 队列",
      callback: () => void this.activateView().then((view) => view?.showQueue())
    });
    this.addCommand({
      id: "open-overview",
      name: "打开项目总览",
      callback: () => void this.activateView().then((view) => view?.showOverview())
    });
    this.addCommand({
      id: "open-board",
      name: "在主窗格打开项目看板…",
      callback: () => {
        void this.store.loadProjects().then(() => {
          new ProjectSuggestModal(this.app, this.store, (p) => void this.openBoardInMainPane(p.id)).open();
        });
      }
    });
    this.addCommand({ id: "review-tasks", name: "任务体检", callback: () => this.openReview() });
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void (this.panelView()?.refresh(true) ?? this.store.loadProjects(true)) });
    this.addCommand({ id: "login", name: "登录滴答清单", callback: () => void this.login().catch(() => null) });
  }

  private onEditorMenu(menu: Menu, editor: Editor, _info: MarkdownView | MarkdownFileInfo): void {
    const text = editor.getSelection().trim();
    if (!text) return;
    const title = text.split("\n")[0].slice(0, 120);
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("创建为滴答待办").setIcon("check-circle").onClick(() => this.createFromText(text, false)));
    menu.addItem((item) => item.setTitle("创建并排到今天").setIcon("calendar-check").onClick(() => this.createFromText(title, true)));
    menu.addItem((item) =>
      item.setTitle("关联到已有待办…").setIcon("link").onClick(() => {
        const note = this.currentNote();
        if (note) this.linkNoteToTask(note);
      })
    );
  }

  private createFromText(text: string, today: boolean): void {
    const lines = text.split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, "").trim()).filter(Boolean);
    const title = (lines[0] ?? text).slice(0, 120);
    const rest = lines.slice(1).join("\n");
    const prefill: Partial<TaskInput> = { title, content: rest };
    if (today) {
      const when = formatDidaDate(startOfDay(new Date()), true);
      prefill.startDate = when;
      prefill.dueDate = when;
      prefill.isAllDay = true;
    }
    this.openCreateModal(prefill);
  }

  private linkNoteToTask(note: NoteRef): void {
    new TaskSuggestModal(this.app, this.api, async (hit) => {
      try {
        const task = await this.api.getTask(hit.id);
        const content = appendNoteLink(task.content, note.vault, note.path);
        if (content === (task.content ?? "")) {
          new Notice("这条待办已经关联了当前笔记");
          return;
        }
        await this.store.updateTask(task, { content });
        new Notice(`已把当前笔记关联到「${task.title}」`);
      } catch (error) {
        new Notice(`关联失败：${this.describeError(error)}`, 6000);
      }
    }).open();
  }
}
