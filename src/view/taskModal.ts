import { Menu, Modal, Notice, setIcon } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { CLEAR_DATE, addDays, formatDidaDate, parseDidaDate, startOfDay, toDateInputValue, toTimeInputValue } from "../dida/dates.ts";
import { appendNoteLink } from "../dida/deeplink.ts";
import { INBOX_ID, PRIORITIES, PRIORITY_LABEL, type DidaColumn, type DidaTask, type Priority, type TaskInput } from "../dida/types.ts";
import { ProjectSuggestModal } from "./projectSuggest.ts";

export interface TaskModalOptions {
  task?: DidaTask;
  prefill?: Partial<TaskInput>;
  onDone?: (task: DidaTask) => void;
}

interface FormState {
  title: string;
  projectId: string;
  columnId: string | null;
  date: string;
  time: string;
  priority: Priority;
  tags: string[];
  content: string;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 新建 / 编辑待办。按 MakerOS 产品界面规范：标题即身份（大字输入，无标签），
 * 项目 / 日期 / 优先级 / 标签都是一排属性胶囊，备注是一个大填充框，底栏只有一个主按钮。
 */
export class TaskModal extends Modal {
  private state: FormState;
  private columns: DidaColumn[] = [];
  private columnsFor: string | null = null;
  private submitting = false;
  private continueAdding = false;
  private customDate = false;
  private tagEditing = false;
  private chipsEl: HTMLElement | null = null;
  private columnsEl: HTMLElement | null = null;
  /** 明确放在「未分组」：新建时用户选的，或编辑一条本来就没分组的任务 */
  private noColumn = false;
  private dateRowEl: HTMLElement | null = null;

  constructor(private readonly plugin: DidaPanelPlugin, private readonly opts: TaskModalOptions) {
    super(plugin.app);
    const t = opts.task;
    const p = opts.prefill ?? {};
    const due = parseDidaDate(t?.dueDate ?? t?.startDate ?? p.dueDate ?? p.startDate ?? null);
    const allDay = t ? t.isAllDay !== false : p.isAllDay !== false;
    this.state = {
      title: t?.title ?? p.title ?? "",
      projectId: t?.projectId ?? p.projectId ?? plugin.settings.defaultProjectId ?? INBOX_ID,
      columnId: t?.columnId ?? p.columnId ?? null,
      date: due ? toDateInputValue(due) : "",
      time: due && !allDay ? toTimeInputValue(due) : "",
      priority: t?.priority ?? p.priority ?? 0,
      tags: [...(t?.tags ?? p.tags ?? [])],
      content: t?.content ?? p.content ?? ""
    };
    this.noColumn = t ? !t.columnId : p.columnId === null;
  }

  get isEdit(): boolean {
    return !!this.opts.task;
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("dida-modal");
    this.contentEl.createDiv({ cls: "dida-loading", text: "加载项目…" });
    try {
      await Promise.all([this.plugin.store.loadProjects(), this.plugin.store.loadTags().catch(() => null)]);
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: "dida-error", text: this.plugin.describeError(error) });
      return;
    }
    this.renderForm();
    void this.loadColumns();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ---------- 数据 ----------

  private async loadColumns(): Promise<void> {
    const project = this.plugin.store.projectById(this.state.projectId);
    const key = this.plugin.store.projectKey(this.state.projectId);
    if (!project || (project.viewMode !== "kanban" && key !== INBOX_ID)) {
      this.columns = [];
      this.columnsFor = key;
      this.renderColumns();
      return;
    }
    if (this.columnsFor === key) return;
    try {
      this.columns = this.plugin.store.getProject(key)?.columns ?? (await this.plugin.api.listColumns(key));
    } catch {
      this.columns = [];
    }
    this.columnsFor = key;
    if (this.columns.length && !this.noColumn && !this.columns.some((c) => c.id === this.state.columnId)) {
      this.state.columnId = this.columns[0].id;
    }
    this.renderColumns();
  }

  private dateLabel(): string | null {
    if (!this.state.date) return null;
    const [y, m, d] = this.state.date.split("-").map(Number);
    const target = new Date(y, m - 1, d);
    const today = startOfDay(new Date());
    const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    let day: string;
    if (diff === 0) day = "今天";
    else if (diff === 1) day = "明天";
    else if (diff > 1 && diff < 7) day = WEEKDAY[target.getDay()];
    else day = `${m}月${d}日`;
    return this.state.time ? `${day} ${this.state.time}` : day;
  }

  // ---------- 渲染 ----------

  private renderForm(): void {
    this.contentEl.empty();
    const form = this.contentEl.createEl("form", { cls: "dida-form" });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submit();
    });
    form.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });

    const head = form.createDiv({ cls: "dida-form-head" });
    head.createDiv({ cls: "dida-form-kicker", text: this.isEdit ? "编辑待办" : "新建待办" });
    const title = head.createEl("input", { type: "text", cls: "dida-title-input", attr: { "aria-label": "标题", placeholder: "要做什么" } });
    title.value = this.state.title;
    title.addEventListener("input", () => (this.state.title = title.value));
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    window.setTimeout(() => title.focus(), 30);

    const props = form.createDiv({ cls: "dida-props" });
    this.chipsEl = props.createDiv({ cls: "dida-chips" });
    this.dateRowEl = props.createDiv({ cls: "dida-date-row" });
    this.columnsEl = props.createDiv({ cls: "dida-columns" });
    this.renderChips();
    this.renderDateRow();

    const note = form.createDiv({ cls: "dida-note" });
    const textarea = note.createEl("textarea", { cls: "dida-note-input", attr: { "aria-label": "备注", rows: "6" } });
    textarea.value = this.state.content;
    textarea.placeholder = "正文：粘贴或插入笔记链接\n来源：素材出处";
    textarea.addEventListener("input", () => (this.state.content = textarea.value));
    const current = this.plugin.currentNote();
    const linkBtn = note.createEl("button", { type: "button", cls: "dida-linkbtn" });
    setIcon(linkBtn, "link");
    const noteName = current ? (current.path.split("/").pop() ?? current.path).replace(/\.md$/, "") : null;
    linkBtn.createSpan({ text: noteName ? `插入当前笔记：${noteName}` : "插入当前笔记" });
    if (current) linkBtn.setAttribute("title", current.path);
    linkBtn.addEventListener("click", () => {
      if (!current) {
        new Notice("当前没有打开的笔记");
        return;
      }
      this.state.content = appendNoteLink(this.state.content, current.vault, current.path);
      textarea.value = this.state.content;
      textarea.focus();
    });

    const footer = form.createDiv({ cls: "dida-form-footer" });
    if (!this.isEdit) {
      const label = footer.createEl("label");
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = this.continueAdding;
      cb.addEventListener("change", () => (this.continueAdding = cb.checked));
      label.createSpan({ text: "创建后继续添加" });
    }
    footer.createDiv({ cls: "dida-form-footer-spacer" });
    const cancel = footer.createEl("button", { type: "button", cls: "is-outline", text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const submit = footer.createEl("button", { type: "submit", cls: "is-primary", text: this.isEdit ? "保存" : "创建待办" });
    submit.createSpan({ cls: "dida-kbd", text: "⌘↩" });

    this.renderColumns();
  }

  private chip(parent: HTMLElement, text: string, opts: { set?: boolean; dashed?: boolean; icon?: "chevron-down" | "x"; label?: string }): HTMLButtonElement {
    const btn = parent.createEl("button", { type: "button", cls: "dida-chip", attr: { "aria-label": opts.label ?? text } });
    if (opts.set) btn.addClass("is-set");
    if (opts.dashed) btn.addClass("is-dashed");
    btn.createSpan({ cls: "dida-chip-text", text });
    if (opts.icon) {
      const ic = btn.createSpan();
      setIcon(ic, opts.icon);
    }
    return btn;
  }

  private renderChips(): void {
    const host = this.chipsEl;
    if (!host) return;
    host.empty();
    const store = this.plugin.store;

    const project = this.chip(host, store.projectName(this.state.projectId), { set: true, icon: "chevron-down", label: "项目" });
    project.addEventListener("click", () => {
      new ProjectSuggestModal(this.app, store, (p) => {
        this.state.projectId = p.id;
        this.state.columnId = null;
        this.noColumn = false;
        this.renderChips();
        void this.loadColumns();
      }).open();
    });

    const dateLabel = this.dateLabel();
    const date = this.chip(host, dateLabel ?? "日期", { set: !!dateLabel, icon: "chevron-down", label: "日期" });
    date.addEventListener("click", (e) => this.dateMenu().showAtMouseEvent(e));

    const prio = this.state.priority;
    const prioChip = this.chip(host, prio ? `${PRIORITY_LABEL[prio]}优先级` : "优先级", { set: prio > 0, icon: "chevron-down", label: "优先级" });
    prioChip.addEventListener("click", (e) => {
      const menu = new Menu();
      for (const p of PRIORITIES) {
        menu.addItem((i) =>
          i
            .setTitle(PRIORITY_LABEL[p])
            .setChecked(this.state.priority === p)
            .onClick(() => {
              this.state.priority = p;
              this.renderChips();
            })
        );
      }
      menu.showAtMouseEvent(e);
    });

    for (const tag of this.state.tags) {
      const chip = this.chip(host, this.plugin.tagLabel(tag), { set: true, icon: "x", label: `移除标签 ${tag}` });
      chip.addEventListener("click", () => {
        this.state.tags = this.state.tags.filter((t) => t !== tag);
        this.renderChips();
      });
    }

    if (this.tagEditing) {
      const input = host.createEl("input", { type: "text", cls: "dida-chip-input", attr: { "aria-label": "添加标签", placeholder: "标签名，回车添加", list: "dida-tag-options" } });
      const datalist = host.createEl("datalist", { attr: { id: "dida-tag-options" } });
      for (const t of store.tags) datalist.createEl("option", { value: t.label });
      const commit = (): void => {
        const value = input.value.trim().replace(/^#/, "");
        if (value && !this.state.tags.includes(value)) this.state.tags.push(value);
        this.tagEditing = false;
        this.renderChips();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          this.tagEditing = false;
          this.renderChips();
        }
      });
      input.addEventListener("blur", commit);
      window.setTimeout(() => input.focus(), 0);
    } else {
      const add = this.chip(host, "+ 标签", { dashed: true, label: "添加标签" });
      add.addEventListener("click", () => {
        this.tagEditing = true;
        this.renderChips();
      });
    }
  }

  private dateMenu(): Menu {
    const menu = new Menu();
    const today = startOfDay(new Date());
    const pick = (d: Date | null): void => {
      this.state.date = d ? toDateInputValue(d) : "";
      if (!d) this.state.time = "";
      this.customDate = false;
      this.renderChips();
      this.renderDateRow();
    };
    menu.addItem((i) => i.setTitle("今天").onClick(() => pick(today)));
    menu.addItem((i) => i.setTitle("明天").onClick(() => pick(addDays(today, 1))));
    menu.addItem((i) => i.setTitle("下周一").onClick(() => pick(addDays(today, ((8 - today.getDay()) % 7) || 7))));
    menu.addItem((i) =>
      i.setTitle("自定义日期和时间…").onClick(() => {
        this.customDate = true;
        if (!this.state.date) this.state.date = toDateInputValue(today);
        this.renderChips();
        this.renderDateRow();
      })
    );
    if (this.state.date) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("清除日期").onClick(() => pick(null)));
    }
    return menu;
  }

  private renderDateRow(): void {
    const host = this.dateRowEl;
    if (!host) return;
    host.empty();
    if (!this.customDate) return;
    const date = host.createEl("input", { type: "date", cls: "dida-date-input", attr: { "aria-label": "日期" } });
    date.value = this.state.date;
    date.addEventListener("change", () => {
      this.state.date = date.value;
      this.renderChips();
    });
    const time = host.createEl("input", { type: "time", cls: "dida-time-input", attr: { "aria-label": "时间" } });
    time.value = this.state.time;
    time.addEventListener("change", () => {
      this.state.time = time.value;
      this.renderChips();
    });
    window.setTimeout(() => date.focus(), 0);
  }

  private renderColumns(): void {
    const host = this.columnsEl;
    if (!host) return;
    host.empty();
    if (!this.columns.length) return;
    host.createSpan({ cls: "dida-columns-label", text: "分组" });
    for (const col of this.columns) {
      const pill = host.createEl("button", { type: "button", cls: "dida-col", text: col.name });
      pill.toggleClass("is-set", !this.noColumn && this.state.columnId === col.id);
      pill.addEventListener("click", () => {
        this.state.columnId = col.id;
        this.noColumn = false;
        this.renderColumns();
      });
    }
    // 接口改不回「没有分组」，所以编辑已分组的任务时不给这个选项
    if (this.isEdit && this.opts.task?.columnId) return;
    const none = host.createEl("button", { type: "button", cls: "dida-col is-none", text: "未分组" });
    none.toggleClass("is-set", this.noColumn);
    none.addEventListener("click", () => {
      this.state.columnId = null;
      this.noColumn = true;
      this.renderColumns();
    });
  }

  // ---------- 提交 ----------

  private buildInput(): TaskInput {
    const input: TaskInput = {
      title: this.state.title.trim(),
      projectId: this.state.projectId,
      columnId: this.state.columnId,
      priority: this.state.priority,
      tags: this.state.tags,
      content: this.state.content
    };
    if (this.state.date) {
      const [y, m, d] = this.state.date.split("-").map(Number);
      const allDay = !this.state.time;
      const [hh, mm] = allDay ? [0, 0] : this.state.time.split(":").map(Number);
      const when = formatDidaDate(new Date(y, m - 1, d, hh, mm), allDay);
      input.startDate = when;
      input.dueDate = when;
      input.isAllDay = allDay;
    } else if (this.isEdit && (this.opts.task?.dueDate || this.opts.task?.startDate)) {
      input.startDate = CLEAR_DATE;
      input.dueDate = CLEAR_DATE;
    }
    return input;
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const input = this.buildInput();
    if (!input.title) {
      new Notice("先写个标题");
      return;
    }
    this.submitting = true;
    try {
      let task: DidaTask;
      if (this.opts.task) {
        const moved = this.plugin.store.projectKey(this.opts.task.projectId) !== this.plugin.store.projectKey(input.projectId);
        if (moved) await this.plugin.store.moveTask(this.opts.task, input.projectId);
        task = await this.plugin.store.updateTask({ ...this.opts.task, projectId: moved ? input.projectId : this.opts.task.projectId }, input);
        new Notice("已保存");
      } else {
        task = await this.plugin.store.createTask(input);
        new Notice(`已创建到「${this.plugin.store.projectName(input.projectId)}」`);
      }
      this.opts.onDone?.(task);
      if (!this.isEdit && this.continueAdding) {
        this.state.title = "";
        this.state.content = this.opts.prefill?.content ?? "";
        this.renderForm();
        this.renderColumns();
        return;
      }
      this.close();
    } catch (error) {
      new Notice(`保存失败：${this.plugin.describeError(error)}`, 6000);
    } finally {
      this.submitting = false;
    }
  }
}
