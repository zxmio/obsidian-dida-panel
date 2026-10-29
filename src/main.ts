import { shell } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileSystemAdapter, Notice, Plugin, type Editor, type MarkdownFileInfo, type MarkdownView, type Menu, type TFile } from "obsidian";
import { DidaApi } from "./dida/api.ts";
import { formatDidaDate, startOfDay } from "./dida/dates.ts";
import { appendNoteLink, boundNotePath, setBodyNote, sourceNotePath, taskWebUrl } from "./dida/deeplink.ts";
import { taskBody, type ChecklistItem, type DidaTask, type TaskInput } from "./dida/types.ts";
import { McpAuthError, McpClient } from "./mcp/client.ts";
import { loginWithBrowser, refreshTokens, tokensExpired } from "./mcp/oauth.ts";
import { DEFAULT_SETTINGS, DidaSettingTab, type DidaSettings } from "./settings.ts";
import { findMakerPilot, sendToMakerPilot } from "./dispatch/makerpilot.ts";
import { dispatchUrl, targetInfo, type DispatchTarget } from "./dispatch/targets.ts";
import { buildDispatchPrompt, isQueued, withQueueTag, withoutQueueTag } from "./dispatch/prompt.ts";
import { DidaStore } from "./store.ts";
import { renderDidaBlock } from "./view/codeblock.ts";
import { DidaPanelView, VIEW_TYPE_DIDA } from "./view/panelView.ts";
import { ProjectSuggestModal } from "./view/projectSuggest.ts";
import { TaskModal, type TaskModalOptions } from "./view/taskModal.ts";
import { TaskSuggestModal } from "./view/taskSuggest.ts";
import { ReviewModal } from "./view/reviewModal.ts";
import { TagManagerModal } from "./view/tagManager.ts";

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
  /** 铺满前左右侧栏是否收起，还原时照这个恢复；为空时还原成都展开 */
  private sidebarsBeforeFull: { left: boolean; right: boolean } | null = null;

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
      completedRange: () => this.settings.completedRange,
      showCompleted: () => this.settings.showCompleted
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

  /** 面板是否开在侧栏里（不在就是主编辑区或弹出窗口） */
  inSidebar(view: DidaPanelView): boolean {
    const root = view.leaf.getRoot();
    return root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit;
  }

  /**
   * 铺满切换：侧栏里的面板挪到主编辑区并收起左右侧栏；主编辑区里的挪回右侧栏，侧栏恢复铺满前的开合。
   * 当前页签、项目和看板模式跟着走。
   */
  async toggleFullscreen(view?: DidaPanelView): Promise<void> {
    const ws = this.app.workspace;
    const current = view ?? ws.getActiveViewOfType(DidaPanelView) ?? this.panelView() ?? (await this.activateView());
    if (!current) return;
    const state = current.getState();
    const from = current.leaf;
    if (this.inSidebar(current)) {
      this.sidebarsBeforeFull = { left: ws.leftSplit.collapsed, right: ws.rightSplit.collapsed };
      const leaf = ws.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_DIDA, active: true, state });
      from.detach();
      ws.leftSplit.collapse();
      ws.rightSplit.collapse();
      void ws.revealLeaf(leaf);
      return;
    }
    // 右侧栏已经有一个面板就复用它，免得开出两个
    const docked = ws.getLeavesOfType(VIEW_TYPE_DIDA).find((l) => l !== from && l.view instanceof DidaPanelView && this.inSidebar(l.view));
    const leaf = docked ?? ws.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_DIDA, active: true, state });
    from.detach();
    const before = this.sidebarsBeforeFull;
    this.sidebarsBeforeFull = null;
    if (!before?.left) ws.leftSplit.expand();
    ws.rightSplit.expand();
    void ws.revealLeaf(leaf);
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
  /**
   * 派给 AI：先打上队列标签，再按 target 打开对应的 AI（不传就用设置里的默认去处）。
   * target 为 "none" 时只进队列，等 Claude Code 的领活循环来取。
   */
  async dispatchTask(task: DidaTask, target: DispatchTarget | "none" = this.settings.aiTarget): Promise<void> {
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
    if (target === "none") {
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
    const info = targetInfo(target);

    if (target === "makerpilot") {
      const result = await sendToMakerPilot(this.app, prompt, this.settings.aiNewConversation);
      if (result === "sent") {
        new Notice("已派给 MakerPilot，确认一下指令再回车");
        return;
      }
      await navigator.clipboard.writeText(prompt);
      new Notice(result === "no-plugin" ? "MakerPilot 未启用，指令已复制到剪贴板" : "MakerPilot 还没准备好，指令已复制到剪贴板", 6000);
      return;
    }

    const url = dispatchUrl(target, prompt, this.dispatchWorkdir());
    if (!url || !appInstalled(info.app)) {
      await navigator.clipboard.writeText(prompt);
      new Notice(`没找到 ${info.app?.replace(/\.app$/, "") ?? info.label}，指令已复制到剪贴板`, 6000);
      return;
    }
    try {
      await shell.openExternal(url);
      new Notice(`已在 ${info.label} 新开会话，确认一下指令再发送`);
    } catch (error) {
      await navigator.clipboard.writeText(prompt);
      new Notice(`打不开 ${info.label}（${error instanceof Error ? error.message : String(error)}），指令已复制到剪贴板`, 6000);
    }
  }

  /** 这个去处现在能不能用：MakerPilot 看插件启用没有，其余看桌面 App 装没装。 */
  dispatchAvailable(target: DispatchTarget): boolean {
    return target === "makerpilot" ? findMakerPilot(this.app) !== null : appInstalled(targetInfo(target).app);
  }

  /** Claude Code、Codex 的工作目录：设置里填了就用，没填用 vault 所在目录。 */
  dispatchWorkdir(): string {
    return this.settings.aiWorkdir.trim() || this.vaultPath();
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

  /**
   * 给任务建一篇笔记并和它绑定：笔记属性里记下滴答待办的地址（dida），待办正文第一行写成「正文：[笔记](obsidian://…)」，
   * 之后卡片上的笔记按钮、操作面板的「笔记」打开的都是它。建好在新页签打开。
   */
  async createNoteForTask(task: DidaTask): Promise<void> {
    const body = taskBody(task);
    const file = await this.createTaskNote({ title: task.title, body, items: task.items ?? [], webUrl: taskWebUrl(task) });
    const note = this.noteRef(file);
    try {
      await this.store.updateTask(task, { content: setBodyNote(body, note.vault, note.path) });
    } catch (error) {
      new Notice(`笔记已建好，但写回待办失败：${this.describeError(error)}`, 6000);
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
    new Notice(`已建笔记「${file.basename}」`);
  }

  /**
   * 建任务笔记的文件本身：放在来源笔记所在的文件夹（通常就是项目目录），没有来源就放在 Obsidian 设置的新笔记位置。
   * 编辑弹窗里还没保存的新待办也走这里，那时还没有滴答地址，保存后再用 bindNoteToTask 补上。
   */
  async createTaskNote(t: { title: string; body: string; items: ChecklistItem[]; webUrl: string | null }): Promise<TFile> {
    const linked = sourceNotePath(t.body) ?? boundNotePath(t.body);
    const linkedFile = linked ? this.app.vault.getAbstractFileByPath(linked) : null;
    const folder = linkedFile?.parent ?? this.app.fileManager.getNewFileParent("");
    const base = (t.title || "未命名待办").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名待办";
    const dir = folder.isRoot() ? "" : `${folder.path}/`;
    let path = `${dir}${base}.md`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${dir}${base} ${n}.md`;
    // 笔记正文不再抄「正文：」那一行（它指向的就是这篇笔记自己）
    const body = t.body.replace(/^正文：.*$/m, "").trim();
    const lines: string[] = ["---", `dida: ${t.webUrl ?? ""}`, "---", ""];
    if (body) lines.push(body, "");
    for (const item of t.items) lines.push(`- [${item.status === 1 ? "x" : " "}] ${item.title}`);
    return this.app.vault.create(path, `${lines.join("\n").trimEnd()}\n`);
  }

  /** 笔记属性里记下它绑定的滴答待办 */
  async bindNoteToTask(file: TFile, task: DidaTask): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm.dida = taskWebUrl(task);
    });
  }

  openTagManager(): void {
    new TagManagerModal(this).open();
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
    this.addCommand({ id: "toggle-fullscreen", name: "铺满 / 还原任务面板", callback: () => void this.toggleFullscreen() });
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
    this.addCommand({ id: "manage-tags", name: "管理标签", callback: () => this.openTagManager() });
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
        const content = appendNoteLink(taskBody(task), note.vault, note.path);
        if (content === taskBody(task)) {
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

/** macOS 上看 App 装没装；其他系统没法判断，直接交给系统去打开。 */
function appInstalled(app: string | null): boolean {
  if (!app || process.platform !== "darwin") return true;
  return [join("/Applications", app), join(homedir(), "Applications", app)].some((p) => existsSync(p));
}
