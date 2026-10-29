import { MarkdownRenderer, Notice, setIcon, type Component } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { findClaudeExecutable } from "../agent/process.ts";
import { AgentSession, type ChatEvent } from "../agent/session.ts";
import { buildSystemPrompt, type PromptContext } from "../agent/systemPrompt.ts";
import { ConfirmModal } from "./confirm.ts";

/** 空对话时的几句起手式，点一下填进输入框。 */
const STARTERS = ["把今天过期的都顺延到明天", "收件箱里哪些该归到项目里？", "这周还有哪些高优先级没做"];

/**
 * 面板底部的 AI 对话框，布局照 MakerPilot：
 * 标题栏（圆点 + 会话名 + 新对话 / 收起）→ 消息区（用户气泡右对齐、回答全宽、执行步骤收进一张可折叠卡片）
 * → 输入框（圆角描边，底栏左边是 AI 看到的范围，右边圆形发送键）。
 * 自己维护 DOM，不随面板主体重绘；每回合结束通知面板刷新。
 */
export class ChatDock {
  private session: AgentSession | null = null;
  private open = false;
  private turns = 0;
  private title = "";
  private unavailable: string | null = null;

  private titleEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private wrapperEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private scopeEl: HTMLElement | null = null;
  private historyBtn: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;

  constructor(
    private readonly plugin: DidaPanelPlugin,
    private readonly host: HTMLElement,
    private readonly owner: Component,
    private readonly context: () => PromptContext,
    private readonly onTurnDone: () => void
  ) {}

  render(): void {
    this.host.empty();
    this.host.addClass("dida-dock");

    // 对话区：标题栏 + 消息
    const chat = this.host.createDiv({ cls: "dida-chat" });
    const header = chat.createDiv({ cls: "dida-chat-header" });
    this.titleEl = header.createDiv({ cls: "dida-chat-title" });
    const actions = header.createDiv({ cls: "dida-chat-actions" });
    this.navButton(actions, "square-pen", "新对话", () => this.newConversation());
    this.navButton(actions, "chevron-down", "收起对话，回到清单", () => this.setOpen(false));
    this.messagesEl = chat.createDiv({ cls: "dida-chat-messages" });
    this.renderWelcome();

    // 输入框
    const composer = this.host.createDiv({ cls: "dida-composer" });
    this.noticeEl = composer.createDiv({ cls: "dida-composer-notice" });
    const wrapper = composer.createDiv({ cls: "dida-input-wrapper" });
    this.wrapperEl = wrapper;
    const textarea = wrapper.createEl("textarea", { cls: "dida-input", attr: { rows: "1", "aria-label": "让 AI 改清单" } });
    textarea.placeholder = "让 AI 帮你改清单…";
    textarea.addEventListener("input", () => {
      this.autosize(textarea);
      this.syncEmpty();
    });
    textarea.addEventListener("focus", () => this.refreshContext());
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      } else if (e.key === "Escape" && this.session?.running) {
        e.preventDefault();
        this.session.stop();
      }
    });
    this.inputEl = textarea;

    const toolbar = wrapper.createDiv({ cls: "dida-input-toolbar" });
    const scope = toolbar.createDiv({ cls: "dida-scope-chip", attr: { "aria-label": "AI 看到的范围" } });
    const scopeIcon = scope.createSpan({ cls: "dida-scope-icon" });
    setIcon(scopeIcon, "crosshair");
    this.scopeEl = scope.createSpan({ cls: "dida-scope-text" });
    toolbar.createDiv({ cls: "dida-input-toolbar-spacer" });
    this.historyBtn = this.toolbarButton(toolbar, "messages-square", "展开对话", () => this.setOpen(!this.open));
    const send = toolbar.createEl("button", { cls: "dida-send-btn", attr: { type: "button", "aria-label": "发送" } });
    setIcon(send, "arrow-up");
    send.addEventListener("click", () => {
      if (this.session?.running) this.session.stop();
      else void this.send();
    });
    this.sendBtn = send;

    this.setOpen(this.open);
    this.updateTitle();
    this.refreshContext();
    this.syncEmpty();
    this.checkAvailability();
  }

  destroy(): void {
    this.session?.stop();
  }

  /** 面板切换页签或项目时调用，让底栏的范围胶囊跟着变。 */
  /** 隐藏对话框前调：对话模式先退出，不然清单会一直藏着 */
  collapse(): void {
    if (this.open) this.setOpen(false);
  }

  refreshContext(): void {
    if (!this.scopeEl) return;
    const ctx = this.context();
    const label = ctx.project ? ctx.project.name : ctx.tab;
    this.scopeEl.setText(ctx.expandedTask ? `${label} · ${ctx.expandedTask.title}` : label);
    this.scopeEl.parentElement?.setAttribute("title", `AI 会把「${label}」当成当前位置`);
  }

  /** 把一句话填进输入框，展开对话；外部入口（比如体检）用。 */
  prefill(text: string): void {
    if (!this.inputEl) return;
    this.inputEl.value = text;
    this.autosize(this.inputEl);
    this.syncEmpty();
    this.inputEl.focus();
  }

  // ---------- 布局 ----------

  private navButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = parent.createEl("button", { cls: "dida-chat-nav-btn", attr: { type: "button", "aria-label": label, title: label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private toolbarButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = parent.createEl("button", { cls: "dida-toolbar-btn", attr: { type: "button", "aria-label": label, title: label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.host.toggleClass("is-open", open);
    // 对话模式：对话铺满整个视图，清单藏起来
    this.host.parentElement?.toggleClass("is-chat", open);
    this.historyBtn?.toggleClass("is-on", open);
    this.historyBtn?.setAttribute("aria-label", open ? "收起对话" : "展开对话");
    if (open) this.scrollToEnd();
  }

  private renderWelcome(): void {
    const box = this.messagesEl?.createDiv({ cls: "dida-chat-welcome" });
    if (!box) return;
    box.createDiv({ cls: "dida-chat-welcome-text", text: "清单要怎么整理？" });
    const list = box.createDiv({ cls: "dida-chat-starters" });
    for (const s of STARTERS) {
      const chip = list.createEl("button", { cls: "dida-chat-starter", text: s, attr: { type: "button" } });
      chip.addEventListener("click", () => this.prefill(s));
    }
    const review = list.createEl("button", { cls: "dida-chat-starter is-review", attr: { type: "button" } });
    const ic = review.createSpan();
    setIcon(ic, "stethoscope");
    review.createSpan({ text: "任务体检：一键查出不合理的任务" });
    review.addEventListener("click", () => this.plugin.openReview());
  }

  private updateTitle(): void {
    if (!this.titleEl) return;
    this.titleEl.setText(this.title || "AI 助手");
    this.titleEl.toggleClass("is-live", !!this.session?.running);
  }

  private autosize(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  private syncEmpty(): void {
    const empty = !this.inputEl?.value.trim();
    this.wrapperEl?.toggleClass("is-empty", empty);
  }

  private scrollToEnd(): void {
    if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private checkAvailability(): void {
    const claude = findClaudeExecutable(this.plugin.settings.claudePath);
    if (!claude) this.unavailable = "没找到 Claude Code。装好后在设置里填路径，或确认它在 PATH 里。";
    else if (!this.plugin.isLoggedIn()) this.unavailable = "先在设置里登录滴答清单。";
    else this.unavailable = null;
    this.noticeEl?.setText(this.unavailable ?? "");
    this.noticeEl?.toggleClass("is-visible", !!this.unavailable);
    if (this.inputEl) this.inputEl.disabled = !!this.unavailable;
    if (this.sendBtn) this.sendBtn.disabled = !!this.unavailable;
  }

  // ---------- 会话 ----------

  private ensureSession(): AgentSession {
    if (this.session) return this.session;
    this.session = new AgentSession({
      vaultPath: this.plugin.vaultPath(),
      claudePath: findClaudeExecutable(this.plugin.settings.claudePath),
      model: this.plugin.settings.claudeModel.trim() || null,
      mcpEndpoint: this.plugin.settings.endpoint,
      getToken: () => this.plugin.accessToken(),
      confirm: (desc) => ConfirmModal.ask(this.plugin.app, desc.title, desc.lines.join("\n") || "（没有更多信息）", "执行", /删除|完成/.test(desc.title)),
      titleOf: (id) => this.plugin.store.taskTitle(id)
    });
    return this.session;
  }

  private newConversation(): void {
    this.session?.reset();
    this.session = null;
    this.turns = 0;
    this.title = "";
    this.messagesEl?.empty();
    this.renderWelcome();
    this.updateTitle();
    this.inputEl?.focus();
  }

  private async send(): Promise<void> {
    const input = this.inputEl;
    const messages = this.messagesEl;
    if (!input || !messages) return;
    this.checkAvailability();
    if (this.unavailable) {
      new Notice(this.unavailable);
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    const session = this.ensureSession();
    if (session.running) return;

    input.value = "";
    this.autosize(input);
    this.syncEmpty();
    this.turns += 1;
    if (!this.title) this.title = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    messages.querySelector(".dida-chat-welcome")?.remove();
    this.setOpen(true);

    const user = messages.createDiv({ cls: "dida-chat-msg is-user" });
    user.createDiv({ cls: "dida-chat-bubble", text });

    const reply = messages.createDiv({ cls: "dida-chat-msg is-ai" });
    const work = new WorkCard(reply);
    const answer = reply.createDiv({ cls: "dida-chat-text is-streaming" });
    const thinking = answer.createDiv({ cls: "dida-chat-thinking", text: "思考中" });

    let buffer = "";
    let renderTimer: number | null = null;
    const flush = (): void => {
      renderTimer = null;
      answer.setText(buffer);
      this.scrollToEnd();
    };

    this.setSending(true);
    this.scrollToEnd();

    const onEvent = (event: ChatEvent): void => {
      switch (event.type) {
        case "text":
          thinking.remove();
          buffer += event.text;
          if (renderTimer === null) renderTimer = window.setTimeout(flush, 80);
          return;
        case "tool_start":
          thinking.remove();
          // 工具前的那段话是过程说明，挪进步骤卡片，回答区只留最后的结论
          if (buffer.trim()) {
            work.note(buffer.trim());
            buffer = "";
            answer.empty();
          }
          work.start(event.id, event.label);
          this.scrollToEnd();
          return;
        case "tool_end":
          work.end(event.id, event.ok, event.detail);
          return;
        case "status":
          work.status(event.text);
          return;
        case "done": {
          if (renderTimer !== null) {
            window.clearTimeout(renderTimer);
            renderTimer = null;
          }
          thinking.remove();
          answer.empty();
          answer.removeClass("is-streaming");
          answer.addClass("markdown-rendered");
          if (buffer.trim()) void MarkdownRenderer.render(this.plugin.app, buffer, answer, "", this.owner);
          else if (event.ok && !work.size) answer.setText("（这一轮没有文字回复）");
          if (!event.ok && event.error) reply.createDiv({ cls: "dida-chat-error", text: event.error });
          work.finish(event.ok);
          this.setSending(false);
          this.scrollToEnd();
          this.inputEl?.focus();
          this.onTurnDone();
          return;
        }
        default:
          return;
      }
    };

    await session.send(text, buildSystemPrompt(this.context()), onEvent);
  }

  private setSending(running: boolean): void {
    if (this.sendBtn) {
      setIcon(this.sendBtn, running ? "square" : "arrow-up");
      this.sendBtn.setAttribute("aria-label", running ? "停止（Esc）" : "发送");
      this.sendBtn.toggleClass("is-stop", running);
    }
    this.updateTitle();
  }
}

/**
 * 一回合的执行步骤卡片：头部写「执行了 N 步」，展开是一条时间线，
 * 每步一个圆形节点（转圈 / 勾 / 叉）。运行中展开，结束后成功则收起。
 */
class WorkCard {
  private readonly el: HTMLElement;
  private readonly header: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly count: HTMLElement;
  private readonly history: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();
  private failed = 0;
  size = 0;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: "dida-work" });
    this.header = this.el.createEl("button", { cls: "dida-work-header", attr: { type: "button", "aria-expanded": "true" } });
    const icon = this.header.createSpan({ cls: "dida-work-icon" });
    setIcon(icon, "list-checks");
    this.label = this.header.createSpan({ cls: "dida-work-label", text: "处理中" });
    this.count = this.header.createSpan({ cls: "dida-work-count" });
    this.history = this.el.createDiv({ cls: "dida-work-history" });
    this.header.addEventListener("click", () => this.setExpanded(this.header.getAttribute("aria-expanded") !== "true"));
  }

  private setExpanded(expanded: boolean): void {
    this.header.setAttribute("aria-expanded", String(expanded));
    this.el.toggleClass("is-collapsed", !expanded);
  }

  private bump(): void {
    this.size += 1;
    this.el.addClass("has-steps");
    this.count.setText(`${this.size} 步`);
  }

  note(text: string): void {
    this.history.createDiv({ cls: "dida-work-note", text });
  }

  start(id: string, label: string): void {
    const row = this.history.createDiv({ cls: "dida-work-step is-running" });
    const node = row.createSpan({ cls: "dida-work-node" });
    setIcon(node, "loader");
    row.createSpan({ cls: "dida-work-step-label", text: label });
    this.rows.set(id, row);
    this.label.setText(label);
    this.bump();
  }

  end(id: string, ok: boolean, detail?: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.removeClass("is-running");
    row.addClass(ok ? "is-done" : "is-error");
    const node = row.querySelector<HTMLElement>(".dida-work-node");
    if (node) setIcon(node, ok ? "check" : "x");
    if (!ok) {
      this.failed += 1;
      if (detail) row.createDiv({ cls: "dida-work-step-detail", text: detail });
    }
  }

  status(text: string): void {
    this.el.addClass("has-steps");
    this.history.createDiv({ cls: "dida-work-note is-status", text });
  }

  finish(ok: boolean): void {
    if (!this.size && !this.history.childElementCount) {
      this.el.remove();
      return;
    }
    this.label.setText(this.failed ? `执行了 ${this.size} 步，${this.failed} 步失败` : `执行了 ${this.size} 步`);
    this.count.setText("");
    this.el.addClass("is-finished");
    if (ok && !this.failed) this.setExpanded(false);
  }
}
