import { Modal, Notice } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import type { DidaProject, ProjectInput } from "../dida/types.ts";
import { ConfirmModal } from "./confirm.ts";

/** 滴答项目调色板里的几种常用色 */
const COLORS = ["#FF6161", "#FFAC38", "#FFD324", "#35D870", "#4CA1FF", "#6E75F4", "#B07CF7", "#A5A5A5"];

export interface ProjectModalOptions {
  /** 有值是编辑，没有是新建 */
  project?: DidaProject;
  /** 新建时默认放进的文件夹 */
  groupId?: string | null;
  onDone?: (project: DidaProject | null) => void;
}

/**
 * 新建 / 编辑项目：名称、文件夹、视图、颜色；编辑时左下角可归档。
 * 滴答的 MCP 不能把项目移出文件夹，所以已在文件夹里的项目不给「不放文件夹」。
 */
export class ProjectModal extends Modal {
  private readonly plugin: DidaPanelPlugin;
  private readonly opts: ProjectModalOptions;
  private name: string;
  private groupId: string | null;
  private viewMode: DidaProject["viewMode"];
  private color: string | null;
  private busy = false;

  constructor(plugin: DidaPanelPlugin, opts: ProjectModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = opts;
    const p = opts.project;
    this.name = p?.name ?? "";
    this.groupId = p ? p.groupId : (opts.groupId ?? null);
    this.viewMode = p?.viewMode ?? "list";
    this.color = p?.color ?? null;
  }

  get isEdit(): boolean {
    return !!this.opts.project;
  }

  onOpen(): void {
    this.modalEl.addClass("dida-modal", "dida-project-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const form = this.contentEl.createEl("form", { cls: "dida-form" });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submit();
    });

    const head = form.createDiv({ cls: "dida-form-head" });
    head.createDiv({ cls: "dida-form-kicker", text: this.isEdit ? "编辑项目" : "新建项目" });
    const title = head.createEl("input", { type: "text", cls: "dida-title-input", attr: { "aria-label": "项目名称", placeholder: "项目名称，开头可以放一个 emoji", maxlength: "64" } });
    title.value = this.name;
    title.addEventListener("input", () => (this.name = title.value));
    window.setTimeout(() => title.focus(), 30);

    const props = form.createDiv({ cls: "dida-props" });
    this.renderGroups(props.createDiv({ cls: "dida-columns" }));
    this.renderViewMode(props.createDiv({ cls: "dida-columns" }));
    this.renderColors(props.createDiv({ cls: "dida-columns" }));

    const footer = form.createDiv({ cls: "dida-form-footer" });
    const project = this.opts.project;
    if (project) {
      const archive = footer.createEl("button", { cls: "is-ghost-danger", text: "归档项目", attr: { type: "button" } });
      archive.addEventListener("click", () => void this.archive(project));
    }
    footer.createDiv({ cls: "dida-form-footer-spacer" });
    footer.createEl("button", { cls: "is-outline", text: "取消", attr: { type: "button" } }).addEventListener("click", () => this.close());
    footer.createEl("button", { cls: "is-primary", text: this.isEdit ? "保存" : "创建项目", attr: { type: "submit" } });
  }

  private pill(parent: HTMLElement, text: string, on: boolean, onClick: () => void, cls = ""): HTMLButtonElement {
    const b = parent.createEl("button", { cls: `dida-col ${cls}`.trim(), text, attr: { type: "button" } });
    b.toggleClass("is-set", on);
    b.addEventListener("click", onClick);
    return b;
  }

  private renderGroups(row: HTMLElement): void {
    const store = this.plugin.store;
    row.createSpan({ cls: "dida-columns-label", text: "文件夹" });
    const canUngroup = !this.isEdit || !this.opts.project?.groupId;
    if (canUngroup) {
      this.pill(row, "不放文件夹", !this.groupId, () => {
        this.groupId = null;
        this.rerender(row, () => this.renderGroups(row));
      }, "is-none");
    }
    for (const g of store.groups) {
      this.pill(row, g.name, this.groupId === g.id, () => {
        this.groupId = g.id;
        this.rerender(row, () => this.renderGroups(row));
      });
    }
  }

  private renderViewMode(row: HTMLElement): void {
    row.createSpan({ cls: "dida-columns-label", text: "视图" });
    for (const [mode, label] of [["list", "列表"], ["kanban", "看板"]] as const) {
      this.pill(row, label, this.viewMode === mode, () => {
        this.viewMode = mode;
        this.rerender(row, () => this.renderViewMode(row));
      });
    }
  }

  private renderColors(row: HTMLElement): void {
    row.createSpan({ cls: "dida-columns-label", text: "颜色" });
    const swatches = row.createDiv({ cls: "dida-swatches" });
    const swatch = (color: string | null): void => {
      const b = swatches.createEl("button", { cls: "dida-swatch", attr: { type: "button", "aria-label": color ?? "无颜色" } });
      if (color) b.style.background = color;
      else b.addClass("is-none");
      b.toggleClass("is-set", (this.color?.toUpperCase() ?? null) === (color?.toUpperCase() ?? null));
      b.addEventListener("click", () => {
        this.color = color;
        this.rerender(row, () => this.renderColors(row));
      });
    };
    swatch(null);
    for (const c of COLORS) swatch(c);
  }

  private rerender(row: HTMLElement, fill: () => void): void {
    row.empty();
    fill();
  }

  private async submit(): Promise<void> {
    const name = this.name.trim();
    if (!name) {
      new Notice("先写项目名称");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    const store = this.plugin.store;
    try {
      const project = this.opts.project;
      if (project) {
        const patch: ProjectInput = {};
        if (name !== project.name) patch.name = name;
        if (this.color !== project.color) patch.color = this.color;
        if (this.viewMode !== project.viewMode && this.viewMode !== "timeline") patch.viewMode = this.viewMode;
        if (this.groupId && this.groupId !== project.groupId) patch.groupId = this.groupId;
        if (Object.keys(patch).length) await store.updateProject(project.id, patch);
        new Notice(`已保存「${name}」`);
        this.opts.onDone?.(store.projectById(project.id));
      } else {
        const created = await store.createProject({ name, groupId: this.groupId, viewMode: this.viewMode === "kanban" ? "kanban" : "list", color: this.color });
        new Notice(`已新建项目「${created.name}」`);
        this.opts.onDone?.(created);
      }
      this.close();
    } catch (error) {
      new Notice(`${this.isEdit ? "保存" : "新建"}失败：${this.plugin.describeError(error)}`, 6000);
    } finally {
      this.busy = false;
    }
  }

  private async archive(project: DidaProject): Promise<void> {
    if (!(await archiveProject(this.plugin, project))) return;
    this.opts.onDone?.(null);
    this.close();
  }
}

/**
 * 归档（关闭）项目。滴答的 MCP 没有删除项目，归档是能做到的最接近的操作，归档后可在滴答里恢复。
 * 返回是否真的归档了。
 */
export async function archiveProject(plugin: DidaPanelPlugin, project: DidaProject): Promise<boolean> {
  const ok = await ConfirmModal.ask(
    plugin.app,
    `归档项目「${project.name}」`,
    "归档后项目和里面的待办都会从面板里消失，可以在滴答清单的「已关闭的清单」里找回。\n\n滴答开放的接口不支持彻底删除项目，要删除请到滴答清单里操作。",
    "归档",
    true
  );
  if (!ok) return false;
  try {
    await plugin.store.updateProject(project.id, { closed: true });
    new Notice(`已归档「${project.name}」`);
    return true;
  } catch (error) {
    new Notice(`归档失败：${plugin.describeError(error)}`, 6000);
    return false;
  }
}
