import { Modal, Notice, setIcon } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { findClaudeExecutable } from "../agent/process.ts";
import { runStructured } from "../agent/oneShot.ts";
import { CLEAR_DATE, formatDidaDate } from "../dida/dates.ts";
import { INBOX_ID, type DidaTask } from "../dida/types.ts";
import {
  REVIEW_ISSUES,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReview,
  pickReviewTasks,
  type ReviewAction,
  type ReviewFinding,
  type ReviewIssue,
  type ReviewKnown,
  type ReviewOption,
  type ReviewProjectRef,
  type ReviewResult
} from "../review/review.ts";
import { ConfirmModal } from "./confirm.ts";

/** null = 全部未完成任务；否则是项目 id（收件箱用 INBOX_ID）。 */
export type ReviewScope = string | null;

type Phase = "setup" | "running" | "done" | "error";

interface FindingState {
  finding: ReviewFinding;
  task: DidaTask;
  /** 已执行的选项文字；忽略时是「忽略」 */
  handled: string | null;
  busy: boolean;
  error: string | null;
}

/**
 * 任务体检：选范围 → Claude 审一遍 → 逐条给处理选项。
 * 选项由插件直接调滴答接口执行；删除仍弹确认框。
 */
export class ReviewModal extends Modal {
  private reviewScope: ReviewScope;
  private phase: Phase = "setup";
  private tasks: DidaTask[] = [];
  private loadingTasks = false;
  private error: string | null = null;
  private result: ReviewResult | null = null;
  private states: FindingState[] = [];
  private filter: ReviewIssue | null = null;
  private abort: AbortController | null = null;
  private timer: number | null = null;
  private startedAt = 0;
  private sentCount = 0;

  constructor(private readonly plugin: DidaPanelPlugin, scope: ReviewScope) {
    super(plugin.app);
    this.reviewScope = scope;
  }

  onOpen(): void {
    this.modalEl.addClass("dida-modal", "dida-review-modal");
    this.render();
    void this.loadScope();
  }

  onClose(): void {
    this.abort?.abort();
    this.stopTimer();
    this.contentEl.empty();
  }

  // ---------- 数据 ----------

  private scopeLabel(scope: ReviewScope = this.reviewScope): string {
    if (scope === null) return "全部待办";
    return this.plugin.store.projectName(scope);
  }

  private async loadScope(): Promise<void> {
    this.phase = "setup";
    this.error = null;
    this.loadingTasks = true;
    this.render();
    try {
      if (this.reviewScope === null) this.tasks = (await this.plugin.store.loadOverview(true)).tasks;
      else this.tasks = (await this.plugin.store.loadProject(this.reviewScope, true)).tasks;
      this.error = null;
    } catch (error) {
      this.tasks = [];
      this.error = this.plugin.describeError(error);
    } finally {
      this.loadingTasks = false;
      this.render();
    }
  }

  private projectRefs(): ReviewProjectRef[] {
    const store = this.plugin.store;
    return store.projects.map((p) => {
      const snap = store.getProject(p.id);
      return {
        id: p.id,
        name: p.name,
        group: store.groupName(p.groupId),
        columns: snap?.columns.length ? snap.columns.map((c) => ({ id: c.id, name: c.name })) : null
      };
    });
  }

  private async run(): Promise<void> {
    const claudePath = findClaudeExecutable(this.plugin.settings.claudePath);
    if (!claudePath) {
      new Notice("没找到 Claude Code。装好后在设置里填路径，或确认它在 PATH 里。");
      return;
    }
    const store = this.plugin.store;
    const now = new Date();
    const sent = pickReviewTasks(this.tasks, now);
    if (!sent.length) {
      new Notice("这个范围里没有未完成的任务");
      return;
    }
    // 送审任务所在项目的列要先拉到，模型才能建议「移到某一列」
    const projectIds = Array.from(new Set(sent.map((t) => store.projectKey(t.projectId))));
    await Promise.all(projectIds.slice(0, 30).map((id) => store.loadProject(id).catch(() => null)));

    const projects = this.projectRefs();
    const known: ReviewKnown = {
      tasks: new Map(sent.map((t) => [t.id, t])),
      projectIds: new Set(projects.map((p) => p.id)),
      columns: new Map(projects.map((p) => [p.id, new Set((p.columns ?? []).map((c) => c.id))])),
      projectKey: (id) => store.projectKey(id)
    };
    const prompt = buildReviewPrompt({ sent, total: this.tasks.filter((t) => !t.parentId).length, projects }, (id) => store.projectName(id), now, this.scopeLabel());

    this.phase = "running";
    this.sentCount = sent.length;
    this.error = null;
    this.startTimer();
    this.render();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const raw = await runStructured(
        { vaultPath: this.plugin.vaultPath(), claudePath, model: this.plugin.settings.claudeModel.trim() || null },
        { systemPrompt: REVIEW_SYSTEM_PROMPT, prompt, schema: REVIEW_SCHEMA, signal: abort.signal }
      );
      const result = parseReview(raw, known);
      this.result = result;
      this.states = result.findings.map((finding) => ({ finding, task: known.tasks.get(finding.taskId) as DidaTask, handled: null, busy: false, error: null }));
      this.filter = null;
      this.phase = "done";
    } catch (error) {
      if (abort.signal.aborted) {
        this.phase = "setup";
      } else {
        this.error = error instanceof Error ? error.message : String(error);
        this.phase = "error";
      }
    } finally {
      this.abort = null;
      this.stopTimer();
      this.render();
    }
  }

  private startTimer(): void {
    this.startedAt = Date.now();
    this.stopTimer();
    this.timer = window.setInterval(() => {
      const el = this.contentEl.querySelector(".dida-review-elapsed");
      if (el) el.setText(`${Math.round((Date.now() - this.startedAt) / 1000)} 秒`);
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- 执行选项 ----------

  private async apply(state: FindingState, option: ReviewOption): Promise<void> {
    const store = this.plugin.store;
    const task = state.task;
    const action: ReviewAction = option.action;
    if (action.type === "delete") {
      const ok = await ConfirmModal.ask(this.app, "删除待办", `「${task.title}」会从滴答清单里彻底删除，不可恢复。`, "删除", true);
      if (!ok) return;
    }
    state.busy = true;
    state.error = null;
    this.render();
    try {
      switch (action.type) {
        case "rename":
          state.task = await store.updateTask(task, { title: action.title });
          break;
        case "move_project":
          await store.moveTask(task, action.projectId);
          break;
        case "move_column":
          state.task = await store.updateTask(task, { columnId: action.columnId });
          break;
        case "set_date": {
          const when = action.date ? formatDidaDate(new Date(`${action.date}T00:00:00`), true) : CLEAR_DATE;
          state.task = await store.updateTask(task, { startDate: when, dueDate: when, isAllDay: true });
          break;
        }
        case "set_priority":
          state.task = await store.updateTask(task, { priority: action.priority });
          break;
        case "add_tags":
          state.task = await store.updateTask(task, { tags: Array.from(new Set([...(task.tags ?? []), ...action.tags])) });
          break;
        case "complete":
          await store.completeTask(task);
          break;
        case "delete":
          await store.deleteTask(task);
          break;
        case "dispatch":
          await this.plugin.dispatchTask(task, "none");
          break;
      }
      state.handled = option.label;
    } catch (error) {
      state.error = this.plugin.describeError(error);
    } finally {
      state.busy = false;
      this.render();
    }
  }

  /** 选项按钮的悬停说明：把动作的具体参数写出来。 */
  private describe(action: ReviewAction): string {
    const store = this.plugin.store;
    switch (action.type) {
      case "rename":
        return `改成「${action.title}」`;
      case "move_project":
        return `移到项目「${store.projectName(action.projectId)}」`;
      case "move_column":
        return "移到同项目的另一列";
      case "set_date":
        return action.date ? `日期改到 ${action.date}` : "清除日期";
      case "set_priority":
        return "改优先级";
      case "add_tags":
        return `加标签：${action.tags.join("、")}`;
      case "complete":
        return "标记完成";
      case "delete":
        return "彻底删除（会再确认一次）";
      case "dispatch":
        return `打上「${this.plugin.settings.aiTag}」标签，进 AI 队列`;
    }
  }

  // ---------- 渲染 ----------

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("dida-review");
    const head = root.createDiv({ cls: "dida-form-head" });
    head.createDiv({ cls: "dida-review-heading", text: "任务体检" });
    if (this.phase === "setup" || this.phase === "error") this.renderSetup(root);
    else if (this.phase === "running") this.renderRunning(root);
    else this.renderResult(root);
  }

  private renderSetup(root: HTMLElement): void {
    const scopes: ReviewScope[] = [null, INBOX_ID];
    if (this.reviewScope && this.reviewScope !== INBOX_ID) scopes.push(this.reviewScope);
    const seg = root.createDiv({ cls: "dida-seg dida-review-scope", attr: { role: "group", "aria-label": "体检范围" } });
    for (const s of scopes) {
      const btn = seg.createEl("button", { text: this.scopeLabel(s), attr: { type: "button" } });
      btn.toggleClass("is-on", s === this.reviewScope);
      btn.addEventListener("click", () => {
        if (s === this.reviewScope) return;
        this.reviewScope = s;
        void this.loadScope();
      });
    }

    const checks = root.createDiv({ cls: "dida-review-checks" });
    for (const issue of REVIEW_ISSUES) checks.createSpan({ cls: "dida-review-issue", text: issue });

    const count = this.tasks.filter((t) => !t.parentId).length;
    const willSend = pickReviewTasks(this.tasks, new Date()).length;
    // 读取失败（phase 仍是 setup）和体检失败（phase 是 error）分开说，读取失败时不报「没有任务」
    const loadFailed = this.phase === "setup" && !!this.error;
    const info = root.createDiv({ cls: "dida-review-info" });
    if (this.loadingTasks) info.setText("正在读取任务…");
    else if (loadFailed) info.setText(`没能读到「${this.scopeLabel()}」的任务。`);
    else if (count) info.setText(`将审查「${this.scopeLabel()}」的 ${willSend} 条未完成任务${count > willSend ? `（共 ${count} 条，先审最久没动的）` : ""}。只出建议，不会自动改任何东西。`);
    else info.setText("这个范围里没有未完成的任务。");

    if (this.error && !this.loadingTasks) root.createDiv({ cls: "dida-review-error", text: loadFailed ? `${this.error}。可以重新读取，或先换成收件箱、单个项目。` : `体检失败：${this.error}` });

    const footer = root.createDiv({ cls: "dida-form-footer" });
    footer.createDiv({ cls: "dida-form-footer-spacer" });
    footer.createEl("button", { cls: "is-outline", text: "取消", attr: { type: "button" } }).addEventListener("click", () => this.close());
    if (loadFailed) {
      footer.createEl("button", { cls: "is-primary", text: "重新读取", attr: { type: "button" } }).addEventListener("click", () => void this.loadScope());
      return;
    }
    const start = footer.createEl("button", { cls: "is-primary", text: this.phase === "error" ? "重新体检" : "开始体检", attr: { type: "button" } });
    start.disabled = this.loadingTasks || !count;
    start.addEventListener("click", () => void this.run());
  }

  private renderRunning(root: HTMLElement): void {
    const box = root.createDiv({ cls: "dida-review-running" });
    const spin = box.createSpan({ cls: "dida-review-spinner" });
    setIcon(spin, "loader");
    box.createDiv({ cls: "dida-review-running-text", text: `正在审查「${this.scopeLabel()}」的 ${this.sentCount} 条任务` });
    box.createDiv({ cls: "dida-review-elapsed", text: "0 秒" });
    const footer = root.createDiv({ cls: "dida-form-footer" });
    footer.createDiv({ cls: "dida-form-footer-spacer" });
    footer.createEl("button", { cls: "is-outline", text: "取消体检", attr: { type: "button" } }).addEventListener("click", () => this.abort?.abort());
  }

  private renderResult(root: HTMLElement): void {
    const result = this.result;
    if (!result) return;
    const handled = this.states.filter((s) => s.handled).length;

    const head = root.createDiv({ cls: "dida-review-head" });
    head.createDiv({ cls: "dida-review-summary", text: result.summary || (this.states.length ? "" : "没发现明显问题。") });
    head.createDiv({ cls: "dida-review-meta", text: `审查 ${this.sentCount} 条 · 发现 ${this.states.length} 条问题${handled ? ` · 已处理 ${handled} 条` : ""}` });

    if (!this.states.length) {
      root.createDiv({ cls: "dida-empty", text: "清单很健康，这次没有需要处理的任务。" });
    } else {
      const counts = new Map<ReviewIssue, number>();
      for (const s of this.states) counts.set(s.finding.issue, (counts.get(s.finding.issue) ?? 0) + 1);
      const filter = root.createDiv({ cls: "dida-filter dida-review-filter" });
      const all = filter.createEl("button", { cls: "dida-ftag", text: `全部 ${this.states.length}`, attr: { type: "button" } });
      all.toggleClass("is-active", this.filter === null);
      all.addEventListener("click", () => {
        this.filter = null;
        this.render();
      });
      for (const issue of REVIEW_ISSUES) {
        const n = counts.get(issue);
        if (!n) continue;
        const btn = filter.createEl("button", { cls: "dida-ftag", text: `${issue} ${n}`, attr: { type: "button" } });
        btn.toggleClass("is-active", this.filter === issue);
        btn.addEventListener("click", () => {
          this.filter = this.filter === issue ? null : issue;
          this.render();
        });
      }

      const list = root.createDiv({ cls: "dida-review-list" });
      for (const state of this.states) {
        if (this.filter && state.finding.issue !== this.filter) continue;
        this.renderFinding(list, state);
      }
    }

    const footer = root.createDiv({ cls: "dida-form-footer" });
    footer.createDiv({ cls: "dida-form-footer-spacer" });
    footer.createEl("button", { cls: "is-outline", text: "重新体检", attr: { type: "button" } }).addEventListener("click", () => {
      this.phase = "setup";
      this.result = null;
      this.states = [];
      void this.loadScope();
    });
    footer.createEl("button", { cls: "is-primary", text: "完成", attr: { type: "button" } }).addEventListener("click", () => this.close());
  }

  private renderFinding(list: HTMLElement, state: FindingState): void {
    const { finding, task } = state;
    const card = list.createDiv({ cls: "dida-review-card" });
    if (state.handled) card.addClass("is-handled");

    const top = card.createDiv({ cls: "dida-review-card-top" });
    top.createSpan({ cls: `dida-review-issue is-${REVIEW_ISSUES.indexOf(finding.issue)}`, text: finding.issue });
    top.createSpan({ cls: "dida-review-project", text: this.plugin.store.projectName(task.projectId) });
    card.createDiv({ cls: "dida-review-title", text: task.title || "（无标题）" });
    if (finding.reason) card.createDiv({ cls: "dida-review-reason", text: finding.reason });
    const rename = finding.options.find((o) => o.action.type === "rename");
    if (rename && rename.action.type === "rename" && !state.handled) {
      const preview = card.createDiv({ cls: "dida-review-preview" });
      const ic = preview.createSpan();
      setIcon(ic, "corner-down-right");
      preview.createSpan({ text: rename.action.title });
    }

    if (state.handled) {
      const done = card.createDiv({ cls: "dida-review-done" });
      const ic = done.createSpan();
      setIcon(ic, "check");
      done.createSpan({ text: state.handled === "忽略" ? "已忽略" : `已处理：${state.handled}` });
      return;
    }

    const actions = card.createDiv({ cls: "dida-review-actions" });
    finding.options.forEach((option, index) => {
      const btn = actions.createEl("button", { text: option.label, attr: { type: "button", title: this.describe(option.action) } });
      if (index === 0) btn.addClass("is-recommended");
      if (option.action.type === "delete") btn.addClass("is-danger");
      btn.disabled = state.busy;
      btn.addEventListener("click", () => void this.apply(state, option));
    });
    const ignore = actions.createEl("button", { cls: "is-ghost", text: "忽略", attr: { type: "button" } });
    ignore.disabled = state.busy;
    ignore.addEventListener("click", () => {
      state.handled = "忽略";
      this.render();
    });
    if (state.busy) actions.createSpan({ cls: "dida-review-busy", text: "处理中…" });
    if (state.error) card.createDiv({ cls: "dida-review-error", text: state.error });
  }
}
