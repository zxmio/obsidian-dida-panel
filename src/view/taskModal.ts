import { Component, Modal, Notice, setIcon, type TFile } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import { CLEAR_DATE, formatDidaDate, parseDidaDate, rescheduleDates, startOfDay, toDateInputValue, toTimeInputValue } from "../dida/dates.ts";
import { appendRelatedNote, boundNotePath, setBodyNote, setSourceNote, sourceNotePath, taskWebUrl } from "../dida/deeplink.ts";
import { INBOX_ID, PRIORITIES, PRIORITY_LABEL, taskBody, type ChecklistItem, type DidaColumn, type DidaTask, type Priority, type TaskInput } from "../dida/types.ts";
import { describeRepeat, repeatOptions, sameRule } from "../dida/repeat.ts";
import { ProjectSuggestModal } from "./projectSuggest.ts";
import { NoteSuggestModal } from "./noteSuggest.ts";
import { renderTaskMarkdown } from "./markdown.ts";
import { openActionMenu } from "./actionMenu.ts";
import { openDatePicker } from "./datePanel.ts";

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
  /** 重复规则，空字符串是不重复 */
  repeat: string;
  /** 清单型任务的检查项；不是清单型时为空，不显示编辑区 */
  items: ChecklistItem[] | null;
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
  /** 正文预览里 Markdown 渲染挂靠的生命周期，弹窗关掉时一起卸载 */
  private readonly preview = new Component();
  /** 新待办在弹窗里建的笔记，保存成功后把待办地址写进笔记属性 */
  private pendingNote: TFile | null = null;
  /** 「添加检查项」里打了字还没回车就点保存，也算一项 */
  private checklistDraft = "";
  private tagEditing = false;
  private chipsEl: HTMLElement | null = null;
  private columnsEl: HTMLElement | null = null;
  /** 明确放在「未分组」：新建时用户选的，或编辑一条本来就没分组的任务 */
  private noColumn = false;

  constructor(private readonly plugin: DidaPanelPlugin, private readonly opts: TaskModalOptions) {
    super(plugin.app);
    const t = opts.task;
    const p = opts.prefill ?? {};
    // 时间段任务（16:00–17:00）弹窗里显示开始时刻，保存时结束跟着挪
    const due = parseDidaDate(t?.startDate ?? t?.dueDate ?? p.startDate ?? p.dueDate ?? null);
    const allDay = t ? t.isAllDay !== false : p.isAllDay !== false;
    this.state = {
      title: t?.title ?? p.title ?? "",
      projectId: t?.projectId ?? p.projectId ?? plugin.settings.defaultProjectId ?? INBOX_ID,
      columnId: t?.columnId ?? p.columnId ?? null,
      date: due ? toDateInputValue(due) : "",
      time: due && !allDay ? toTimeInputValue(due) : "",
      priority: t?.priority ?? p.priority ?? 0,
      tags: [...(t?.tags ?? p.tags ?? [])],
      content: t ? taskBody(t) : (p.content ?? ""),
      repeat: t?.repeatFlag ?? p.repeatFlag ?? "",
      items: t && (t.kind === "CHECKLIST" || t.items?.length) ? (t.items ?? []).map((i) => ({ ...i })) : null
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
    this.preview.unload();
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
    this.columnsEl = props.createDiv({ cls: "dida-columns" });
    this.renderChips();

    // 正文有内容时先显示渲染后的样子（链接只露出文件名、可点），点正文空白处才切到原文编辑，失焦回到预览
    const note = form.createDiv({ cls: "dida-note" });
    const view = note.createDiv({ cls: "dida-note-view dida-md", attr: { title: "点击编辑" } });
    const textarea = note.createEl("textarea", { cls: "dida-note-input", attr: { "aria-label": "备注", rows: "6" } });
    textarea.value = this.state.content;
    textarea.placeholder = "正文：粘贴或插入笔记链接\n来源：素材出处";
    textarea.addEventListener("input", () => (this.state.content = textarea.value));
    this.preview.load();
    const showPreview = (): void => {
      const body = this.state.content.trim();
      note.toggleClass("is-preview", !!body);
      if (!body) return;
      renderTaskMarkdown(this.app, this.state.content, view, this.preview, (next) => {
        this.state.content = next;
        textarea.value = next;
        showPreview();
      });
    };
    const edit = (): void => {
      note.removeClass("is-preview");
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    };
    view.addEventListener("click", (e) => {
      // 点链接照常打开、点勾选框改勾选，点别处进入编辑
      if ((e.target as HTMLElement).closest("a, input")) return;
      edit();
    });
    textarea.addEventListener("blur", showPreview);
    showPreview();
    // 正文下面的工具条：来源、插入笔记都是从 vault 挑一篇（当前打开的排第一），创建笔记直接建一篇并把链接写进正文
    const setContent = (next: string): void => {
      this.state.content = next;
      textarea.value = next;
      showPreview();
      renderTools();
    };
    // 三个按钮对应正文里三种链接（见 deeplink.ts）：来源只有一条、换了就替换；关联可以加很多条；
    // 笔记是这条待办自己绑定的那一篇，没绑定时是「创建笔记」，绑定后变成「打开笔记」
    const tools = form.createDiv({ cls: "dida-note-tools" });
    const renderTools = (): void => {
      tools.empty();
      const tool = (icon: string, label: string, hint: string, run: () => void): void => {
        const b = tools.createEl("button", { cls: "dida-note-tool", attr: { type: "button", title: hint } });
        setIcon(b, icon);
        b.createSpan({ text: label });
        b.addEventListener("click", run);
      };
      const source = sourceNotePath(this.state.content);
      tool("quote", source ? "换来源" : "来源", "这条待办是从哪篇笔记里来的（会议纪要、复盘），只记一篇，再选就替换", () =>
        new NoteSuggestModal(this.app, "选来源笔记", (file) => {
          const ref = this.plugin.noteRef(file);
          setContent(setSourceNote(this.state.content, ref.vault, ref.path));
        }).open()
      );
      tool("link", "关联笔记", "加一篇参考笔记，在末尾追加一行「关联：」，可以加很多篇", () =>
        new NoteSuggestModal(this.app, "选要关联的笔记", (file) => {
          const ref = this.plugin.noteRef(file);
          setContent(appendRelatedNote(this.state.content, ref.vault, ref.path));
        }).open()
      );
      const bound = /^正文：/m.test(this.state.content) ? boundNotePath(this.state.content) : null;
      if (bound) tool("file-text", "打开笔记", `打开这条待办绑定的笔记：${bound}`, () => void this.app.workspace.openLinkText(bound, "", "tab"));
      else tool("file-plus", "创建笔记", "用这条待办建一篇笔记并和它绑定：笔记里记下待办地址，待办正文第一行写上笔记链接", () => void this.createNote(setContent));
    };
    renderTools();

    if (this.state.items) this.renderChecklist(form.createDiv({ cls: "dida-tm-checklist" }), this.state.items);

    const footer = form.createDiv({ cls: "dida-form-footer" });
    if (!this.isEdit) {
      const label = footer.createEl("label");
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = this.continueAdding;
      cb.addEventListener("change", () => (this.continueAdding = cb.checked));
      label.createSpan({ text: "创建后继续添加" });
    }
    footer.createDiv({ cls: "dida-form-footer-spacer" });
    const cancel = footer.createEl("button", { cls: "is-outline", text: "取消", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = footer.createEl("button", { cls: "is-primary", text: this.isEdit ? "保存" : "创建待办", attr: { type: "submit" } });
    submit.createSpan({ cls: "dida-kbd", text: "⌘↩" });

    this.renderColumns();
  }

  private chip(parent: HTMLElement, text: string, opts: { set?: boolean; dashed?: boolean; icon?: "chevron-down" | "x"; label?: string }): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: "dida-chip", attr: { type: "button", "aria-label": opts.label ?? text } });
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
    date.addEventListener("click", () => this.openDate(date.getBoundingClientRect()));

    const repeatLabel = describeRepeat(this.state.repeat);
    const repeatChip = this.chip(host, repeatLabel ?? "重复", { set: !!repeatLabel, icon: "chevron-down", label: "重复" });
    repeatChip.addEventListener("click", () => {
      const base = this.state.date ? new Date(`${this.state.date}T00:00:00`) : new Date();
      openActionMenu(this.modalEl.doc, repeatChip.getBoundingClientRect(), {
        groups: [
          repeatOptions(base).map((o) => ({
            icon: "repeat",
            label: o.label,
            checked: sameRule(this.state.repeat, o.rule),
            run: () => {
              this.state.repeat = o.rule;
              // 重复要有起始日，没选日期就从今天开始
              if (!this.state.date) this.state.date = toDateInputValue(new Date());
              this.renderChips();
            }
          })),
          this.state.repeat
            ? [
                {
                  icon: "x",
                  label: "不重复",
                  run: () => {
                    this.state.repeat = "";
                    this.renderChips();
                  }
                }
              ]
            : []
        ]
      });
    });

    const prio = this.state.priority;
    const prioChip = this.chip(host, prio ? `${PRIORITY_LABEL[prio]}优先级` : "优先级", { set: prio > 0, icon: "chevron-down", label: "优先级" });
    prioChip.addEventListener("click", () =>
      openActionMenu(this.modalEl.doc, prioChip.getBoundingClientRect(), {
        groups: [
          [...PRIORITIES].reverse().map((p) => ({
            icon: "flag",
            label: p ? `${PRIORITY_LABEL[p]}优先级` : "无优先级",
            checked: this.state.priority === p,
            run: () => {
              this.state.priority = p;
              this.renderChips();
            }
          }))
        ]
      })
    );

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
          // 只退出标签输入；不拦的话 Obsidian 会把整个弹窗一起关掉
          e.preventDefault();
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

  /** 日期面板和快速添加的日期按钮是同一个：常用日期、月历、时刻，选完直接写回。 */
  private openDate(rect: DOMRect): void {
    let value: Date | null = null;
    if (this.state.date) {
      const [y, m, d] = this.state.date.split("-").map(Number);
      const [hh, mm] = (this.state.time || "00:00").split(":").map(Number);
      value = new Date(y, m - 1, d, hh, mm);
    }
    openDatePicker(this.modalEl.doc, rect, { date: value, allDay: !this.state.time }, (next) => {
      this.state.date = next.date ? toDateInputValue(next.date) : "";
      this.state.time = next.date && !next.allDay ? toTimeInputValue(next.date) : "";
      this.renderChips();
    });
  }

  private renderColumns(): void {
    const host = this.columnsEl;
    if (!host) return;
    host.empty();
    if (!this.columns.length) return;
    host.createSpan({ cls: "dida-columns-label", text: "分组" });
    for (const col of this.columns) {
      const pill = host.createEl("button", { cls: "dida-col", text: col.name, attr: { type: "button" } });
      pill.toggleClass("is-set", !this.noColumn && this.state.columnId === col.id);
      pill.addEventListener("click", () => {
        this.state.columnId = col.id;
        this.noColumn = false;
        this.renderColumns();
      });
    }
    // 接口改不回「没有分组」，所以编辑已分组的任务时不给这个选项
    if (this.isEdit && this.opts.task?.columnId) return;
    const none = host.createEl("button", { cls: "dida-col is-none", text: "未分组", attr: { type: "button" } });
    none.toggleClass("is-set", this.noColumn);
    none.addEventListener("click", () => {
      this.state.columnId = null;
      this.noColumn = true;
      this.renderColumns();
    });
  }

  /** 弹窗里建笔记：用当前填的标题、正文、检查项；笔记在后台页签打开，弹窗不关 */
  private async createNote(setContent: (next: string) => void): Promise<void> {
    const title = this.state.title.trim();
    if (!title) {
      new Notice("先填标题再建笔记");
      return;
    }
    try {
      const task = this.opts.task;
      const file = await this.plugin.createTaskNote({
        title,
        body: this.state.content,
        items: this.state.items ?? [],
        webUrl: task ? taskWebUrl(task) : null
      });
      const ref = this.plugin.noteRef(file);
      setContent(setBodyNote(this.state.content, ref.vault, ref.path));
      if (task) {
        // 已有的待办马上把绑定写回滴答，不等保存：弹窗取消了笔记也不会变成孤儿
        this.opts.task = await this.plugin.store.updateTask(task, { content: this.state.content });
        new Notice(`已建笔记「${file.basename}」并绑定到这条待办`);
      } else {
        // 新待办还没有滴答地址，保存成功后再写进笔记属性
        this.pendingNote = file;
        new Notice(`已建笔记「${file.basename}」，保存待办后自动绑定`);
      }
      await this.app.workspace.getLeaf("tab").openFile(file, { active: false });
    } catch (error) {
      new Notice(`建笔记失败：${this.plugin.describeError(error)}`, 6000);
    }
  }

  /**
   * 检查项编辑：勾选、改字、删除，最后一行输入回车追加。回车只在检查项之间跳，不提交整个表单。
   * focusIndex 是重画后要放光标的那一行（追加、删除后用）。
   */
  private renderChecklist(host: HTMLElement, items: ChecklistItem[], focusIndex: number | null = null): void {
    host.empty();
    const rerender = (focus: number | null): void => this.renderChecklist(host, items, focus);
    items.forEach((item, index) => {
      const row = host.createDiv({ cls: "dida-tm-item" });
      row.toggleClass("is-done", item.status === 1);
      const box = row.createEl("input", { type: "checkbox", cls: "dida-checklist-box", attr: { "aria-label": "完成这一项" } });
      box.checked = item.status === 1;
      box.addEventListener("change", () => {
        item.status = box.checked ? 1 : 0;
        row.toggleClass("is-done", box.checked);
      });
      const text = row.createEl("input", { type: "text", cls: "dida-tm-item-input", attr: { "aria-label": "检查项" } });
      text.value = item.title;
      text.addEventListener("input", () => (item.title = text.value));
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && !(e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          items.splice(index + 1, 0, { id: "", title: "", status: 0, sortOrder: 0 });
          rerender(index + 1);
        } else if (e.key === "Backspace" && !text.value && !e.isComposing) {
          e.preventDefault();
          items.splice(index, 1);
          rerender(Math.max(0, index - 1));
        }
      });
      const del = row.createEl("button", { cls: "dida-tm-item-del", attr: { type: "button", "aria-label": "删除这一项" } });
      setIcon(del, "x");
      del.addEventListener("click", () => {
        items.splice(index, 1);
        rerender(null);
      });
      if (focusIndex === index) window.setTimeout(() => text.focus(), 0);
    });
    const add = host.createDiv({ cls: "dida-tm-item is-add" });
    setIcon(add.createSpan({ cls: "dida-tm-item-plus" }), "plus");
    const input = add.createEl("input", { type: "text", cls: "dida-tm-item-input", attr: { placeholder: "添加检查项，回车继续", "aria-label": "添加检查项" } });
    input.value = this.checklistDraft;
    input.addEventListener("input", () => (this.checklistDraft = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      items.push({ id: "", title, status: 0, sortOrder: 0 });
      this.checklistDraft = "";
      rerender(items.length);
    });
    if (focusIndex === items.length) window.setTimeout(() => input.focus(), 0);
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
    // 重复只在改过时写：新建时有值才发，编辑时和原来不同才发（空字符串是取消重复）
    if (this.state.repeat !== (this.opts.task?.repeatFlag ?? "")) input.repeatFlag = this.state.repeat;
    // 检查项只在改动过时才整组写回，空行丢掉，顺序按当前排列重排
    if (this.state.items) {
      const draft = this.checklistDraft.trim();
      const all = draft ? [...this.state.items, { id: "", title: draft, status: 0 as const, sortOrder: 0 }] : this.state.items;
      const items = all.filter((i) => i.title.trim()).map((i, n): ChecklistItem => ({ ...i, title: i.title.trim(), sortOrder: n }));
      const before = (this.opts.task?.items ?? []).map((i) => [i.id, i.title, i.status]);
      const after = items.map((i) => [i.id, i.title, i.status]);
      if (JSON.stringify(before) !== JSON.stringify(after)) input.items = items;
    }
    if (this.state.date) {
      const [y, m, d] = this.state.date.split("-").map(Number);
      const allDay = !this.state.time;
      const [hh, mm] = allDay ? [0, 0] : this.state.time.split(":").map(Number);
      const start = new Date(y, m - 1, d, hh, mm);
      if (this.opts.task) {
        Object.assign(input, rescheduleDates(this.opts.task, start, allDay));
      } else {
        const when = formatDidaDate(start, allDay);
        input.startDate = when;
        input.dueDate = when;
        input.isAllDay = allDay;
      }
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
        if (this.pendingNote) {
          const note = this.pendingNote;
          this.pendingNote = null;
          await this.plugin.bindNoteToTask(note, task).catch((error: unknown) => new Notice(`待办已建好，但笔记没绑上：${this.plugin.describeError(error)}`, 6000));
        }
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
