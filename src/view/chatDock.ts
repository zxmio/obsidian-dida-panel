import { MarkdownRenderer, Notice, setIcon, type Component } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { findClaudeExecutable } from "../agent/process.ts";
import { AgentSession, type ChatEvent } from "../agent/session.ts";
import { buildSystemPrompt, type PromptContext } from "../agent/systemPrompt.ts";
import { ConfirmModal } from "./confirm.ts";

/**
 * 面板底部的 AI 对话框：输入一句话，Claude Code 通过滴答 MCP 增删改查。
 * 自己维护 DOM，不随面板主体重绘；每回合结束通知面板刷新。
 */
export class ChatDock {
  private session: AgentSession | null = null;
  private open = false;
  private logEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private toggleEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private turns = 0;
  private unavailable: string | null = null;

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

    const bar = this.host.createDiv({ cls: "dida-dock-bar" });
    const toggle = bar.createEl("button", { cls: "dida-dock-toggle", attr: { type: "button", "aria-label": "展开或收起对话" } });
    const chev = toggle.createSpan();
    setIcon(chev, this.open ? "chevron-down" : "chevron-up");
    toggle.createSpan({ text: "AI 对话" });
    this.countEl = toggle.createSpan({ cls: "dida-group-count", text: this.turns ? String(this.turns) : "" });
    toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.toggleEl = chev;
    this.statusEl = bar.createSpan({ cls: "dida-dock-status" });
    bar.createSpan({ cls: "dida-group-spacer" });
    const reset = bar.createEl("button", { cls: "dida-dock-reset", text: "新对话", attr: { type: "button" } });
    reset.addEventListener("click", () => this.newConversation());

    this.logEl = this.host.createDiv({ cls: "dida-dock-log" });
    this.logEl.toggleClass("is-open", this.open);

    const inputRow = this.host.createDiv({ cls: "dida-dock-input" });
    const textarea = inputRow.createEl("textarea", { cls: "dida-dock-textarea", attr: { rows: "1", "aria-label": "让 AI 改清单" } });
    textarea.placeholder = "让 AI 改清单：把今天过期的都推到明天";
    textarea.addEventListener("input", () => this.autosize(textarea));
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
    const send = inputRow.createEl("button", { cls: "dida-dock-send", attr: { type: "button", "aria-label": "发送" } });
    setIcon(send, "arrow-up");
    send.addEventListener("click", () => {
      if (this.session?.running) this.session.stop();
      else void this.send();
    });
    this.sendBtn = send;

    this.checkAvailability();
  }

  destroy(): void {
    this.session?.stop();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.logEl?.toggleClass("is-open", open);
    if (this.toggleEl) setIcon(this.toggleEl, open ? "chevron-down" : "chevron-up");
    if (open) this.scrollToEnd();
  }

  private autosize(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  private checkAvailability(): void {
    const claude = findClaudeExecutable(this.plugin.settings.claudePath);
    if (!claude) {
      this.unavailable = "没找到 Claude Code。装好后在设置里填路径，或确认它在 PATH 里。";
    } else if (!this.plugin.isLoggedIn()) {
      this.unavailable = "先在设置里登录滴答清单。";
    } else {
      this.unavailable = null;
    }
    if (this.statusEl) this.statusEl.setText(this.unavailable ?? "");
    if (this.inputEl) this.inputEl.disabled = !!this.unavailable;
    if (this.sendBtn) this.sendBtn.disabled = !!this.unavailable;
  }

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
    this.logEl?.empty();
    this.countEl?.setText("");
    this.setStatus("");
    this.inputEl?.focus();
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  private scrollToEnd(): void {
    if (this.logEl) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private async send(): Promise<void> {
    const input = this.inputEl;
    if (!input) return;
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
    this.turns += 1;
    this.countEl?.setText(String(this.turns));
    this.setOpen(true);

    const log = this.logEl;
    if (!log) return;
    log.createDiv({ cls: "dida-msg is-user", text });
    const reply = log.createDiv({ cls: "dida-msg is-ai" });
    const body = reply.createDiv({ cls: "dida-msg-body" });
    const steps = reply.createDiv({ cls: "dida-msg-steps" });
    const toolRows = new Map<string, HTMLElement>();
    let buffer = "";
    let renderTimer: number | null = null;
    const flush = (): void => {
      renderTimer = null;
      body.setText(buffer);
      this.scrollToEnd();
    };

    this.setSending(true);
    this.setStatus("思考中…");

    const onEvent = (event: ChatEvent): void => {
      switch (event.type) {
        case "text":
          buffer += event.text;
          if (renderTimer === null) renderTimer = window.setTimeout(flush, 80);
          return;
        case "tool_start": {
          const row = steps.createDiv({ cls: "dida-step is-running" });
          const ic = row.createSpan({ cls: "dida-step-icon" });
          setIcon(ic, "loader");
          row.createSpan({ text: event.label });
          toolRows.set(event.id, row);
          this.setStatus(event.label);
          this.scrollToEnd();
          return;
        }
        case "tool_end": {
          const row = toolRows.get(event.id);
          if (!row) return;
          row.removeClass("is-running");
          row.addClass(event.ok ? "is-done" : "is-error");
          const ic = row.querySelector<HTMLElement>(".dida-step-icon");
          if (ic) setIcon(ic, event.ok ? "check" : "x");
          if (!event.ok && event.detail) row.createSpan({ cls: "dida-step-detail", text: event.detail });
          return;
        }
        case "status":
          this.setStatus(event.text);
          return;
        case "done": {
          if (renderTimer !== null) {
            window.clearTimeout(renderTimer);
            renderTimer = null;
          }
          body.empty();
          if (buffer.trim()) void MarkdownRenderer.render(this.plugin.app, buffer, body, "", this.owner);
          if (!event.ok && event.error) {
            reply.createDiv({ cls: "dida-msg-error", text: event.error });
          } else if (!buffer.trim() && event.ok) {
            body.setText("（这一轮没有文字回复）");
          }
          this.setSending(false);
          this.setStatus("");
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
      this.sendBtn.setAttribute("aria-label", running ? "停止" : "发送");
      this.sendBtn.toggleClass("is-running", running);
    }
  }
}
