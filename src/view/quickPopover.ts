import { setIcon } from "obsidian";

export interface PopoverItemOptions {
  icon?: string;
  /** 单色 SVG logo，优先于 icon */
  logo?: { viewBox: string; path: string } | null;
  /** 图标位置换成一个色点，用于标签颜色 */
  dot?: string | null;
  label: string;
  hint?: string;
  /** 右侧小标签，比如「默认」 */
  badge?: string;
  /** 悬停时出现在右侧的次要操作，点它不触发 onSelect */
  action?: { label: string; run: () => void };
  /** 灰掉，不能选，键盘也跳过 */
  disabled?: boolean;
  checked?: boolean;
  /** 多选列表用方框勾选，单选列表用右侧对勾 */
  checkbox?: boolean;
  cls?: string;
  onSelect: () => void;
}

export interface QuickPopoverOptions {
  cls: string;
  /** 有值时顶部放一个搜索框，焦点落在搜索框里 */
  search?: string;
  render: (pop: QuickPopover, body: HTMLElement, query: string) => void;
  /** 面板里按下的字符键，返回 true 表示已处理（如优先级的 1 2 3 0） */
  onKey?: (key: string) => boolean;
  onClose: (byKeyboard: boolean) => void;
}

/**
 * 锚在快捷按钮下方的弹出面板：上下键移动、回车选择、Esc 关闭、点外面关闭。
 * 内容由调用方渲染，选完后调 refresh() 重画（多选）或 close()（单选）。
 */
export class QuickPopover {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly searchEl: HTMLInputElement | null = null;
  private items: HTMLElement[] = [];
  private active = -1;
  private closed = false;
  private readonly anchorRect: DOMRect;
  private readonly opts: QuickPopoverOptions;
  private readonly onOutside = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Node) || this.el.contains(target)) return;
    // 点快捷按钮由按钮自己决定是切换还是关闭
    if (target instanceof Element && target.closest(".dida-qchip")) return;
    this.close();
  };
  private readonly onResize = (): void => this.close();

  /** rect 是打开时按钮的位置：按钮会随输入重画，所以只记位置不记元素。 */
  constructor(doc: Document, rect: DOMRect, opts: QuickPopoverOptions) {
    this.opts = opts;
    this.anchorRect = rect;
    this.el = doc.body.createDiv({ cls: `dida-pop ${opts.cls}` });
    this.el.tabIndex = -1;
    if (opts.search !== undefined) {
      const head = this.el.createDiv({ cls: "dida-pop-search" });
      setIcon(head.createSpan({ cls: "dida-pop-search-icon" }), "search");
      this.searchEl = head.createEl("input", { type: "text", attr: { placeholder: opts.search, spellcheck: "false" } });
      this.searchEl.addEventListener("input", () => this.refresh(true));
    }
    this.body = this.el.createDiv({ cls: "dida-pop-body" });
    this.el.addEventListener("keydown", (e) => this.handleKey(e));
    this.refresh(true);
    doc.addEventListener("mousedown", this.onOutside, true);
    doc.win.addEventListener("resize", this.onResize);
    window.setTimeout(() => (this.searchEl ?? this.el).focus(), 0);
  }

  get query(): string {
    return this.searchEl?.value.trim() ?? "";
  }

  clearSearch(): void {
    if (this.searchEl) this.searchEl.value = "";
  }

  /** 重画内容；resetActive 为 false 时保留当前高亮的位置（多选连续操作）。 */
  refresh(resetActive = false): void {
    if (this.closed) return;
    const keep = this.active;
    this.items = [];
    this.body.empty();
    this.opts.render(this, this.body, this.query);
    this.place();
    this.setActive(resetActive ? (this.items.length ? 0 : -1) : Math.min(keep, this.items.length - 1));
  }

  section(parent: HTMLElement, title?: string): HTMLElement {
    const sec = parent.createDiv({ cls: "dida-pop-section" });
    if (title) sec.createDiv({ cls: "dida-pop-title", text: title });
    return sec;
  }

  item(parent: HTMLElement, o: PopoverItemOptions): HTMLElement {
    const row = parent.createDiv({ cls: `dida-pop-item ${o.cls ?? ""}`.trim() });
    row.toggleClass("is-checked", !!o.checked);
    if (o.checkbox) {
      const box = row.createSpan({ cls: "dida-pop-box" });
      if (o.checked) setIcon(box, "check");
    }
    if (o.dot !== undefined) {
      const dot = row.createSpan({ cls: "dida-pop-dot" });
      if (o.dot) dot.style.background = o.dot;
    } else if (o.logo) {
      const box = row.createSpan({ cls: "dida-pop-icon is-logo" });
      const ns = "http://www.w3.org/2000/svg";
      const svg = box.doc.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", o.logo.viewBox);
      svg.setAttribute("fill", "currentColor");
      const path = box.doc.createElementNS(ns, "path");
      path.setAttribute("d", o.logo.path);
      svg.appendChild(path);
      box.appendChild(svg);
    } else if (o.icon) {
      setIcon(row.createSpan({ cls: "dida-pop-icon" }), o.icon);
    }
    row.createSpan({ cls: "dida-pop-label", text: o.label });
    if (o.badge) row.createSpan({ cls: "dida-pop-badge", text: o.badge });
    if (o.action) {
      const { label, run } = o.action;
      const btn = row.createEl("button", { cls: "dida-pop-action", text: label, attr: { type: "button" } });
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        run();
      });
    }
    if (o.hint) row.createSpan({ cls: "dida-pop-hint", text: o.hint });
    if (o.checked && !o.checkbox) setIcon(row.createSpan({ cls: "dida-pop-check" }), "check");
    if (o.disabled) {
      row.addClass("is-disabled");
      return row;
    }
    const index = this.items.length;
    this.items.push(row);
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("mousemove", () => {
      if (this.active !== index) this.setActive(index);
    });
    row.addEventListener("click", () => {
      this.active = index;
      o.onSelect();
    });
    return row;
  }

  close(byKeyboard = false): void {
    if (this.closed) return;
    this.closed = true;
    const doc = this.el.doc;
    doc.removeEventListener("mousedown", this.onOutside, true);
    doc.win.removeEventListener("resize", this.onResize);
    this.el.remove();
    this.opts.onClose(byKeyboard);
  }

  private setActive(index: number): void {
    this.items[this.active]?.removeClass("is-active");
    this.active = index;
    const row = this.items[index];
    if (!row) return;
    row.addClass("is-active");
    // 只滚面板里的列表，scrollIntoView 会连带滚动整个页面
    const box = row.closest(".is-scroll") ?? this.body;
    if (!(box instanceof HTMLElement)) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.setActive((this.active + step + this.items.length) % this.items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.items[this.active]?.click();
    } else if (!this.searchEl && e.key.length === 1 && !e.metaKey && !e.ctrlKey && this.opts.onKey?.(e.key)) {
      e.preventDefault();
    }
  }

  /** 摆在按钮下方，下方放不下就翻到上方。 */
  private place(): void {
    const win = this.el.win;
    const rect = this.anchorRect;
    const width = this.el.offsetWidth;
    const height = this.el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top = below + height > win.innerHeight - 8 && rect.top - height - 4 > 8 ? rect.top - height - 4 : below;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}
