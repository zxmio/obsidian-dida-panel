import { Modal, Notice, setIcon } from "obsidian";
import type DidaPanelPlugin from "../main.ts";
import type { DidaTag } from "../dida/types.ts";

/** 滴答对标签名的限制：不能有空白和 \ / " # : * ? < > | */
const BAD_CHARS = /[\s\\/"#:*?<>|]/;

/**
 * 标签管理：列出全部标签，改名或删除。两者都会改到所有带这个标签的任务（滴答那边一起改），
 * 所以删除点一下先变成「确认删除」，3 秒内再点一次才删，不另弹确认框。
 */
export class TagManagerModal extends Modal {
  /** 正在改名的那个标签 */
  private editing: string | null = null;
  private armed: string | null = null;
  private armTimer = 0;
  private busy = false;

  constructor(private readonly plugin: DidaPanelPlugin) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("dida-modal");
    this.titleEl.setText("标签管理");
    this.contentEl.createDiv({ cls: "dida-loading", text: "加载标签…" });
    await this.plugin.store.loadTags(true).catch((error: unknown) => new Notice(`读取标签失败：${this.plugin.describeError(error)}`));
    this.render();
  }

  onClose(): void {
    window.clearTimeout(this.armTimer);
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const tags = [...this.plugin.store.tags].sort((a, b) => a.label.localeCompare(b.label, "zh"));
    if (!tags.length) {
      el.createDiv({ cls: "dida-tagm-empty", text: "还没有标签" });
      return;
    }
    el.createDiv({ cls: "dida-tagm-hint", text: "改名和删除会同步到所有带这个标签的任务" });
    const list = el.createDiv({ cls: "dida-tagm-list" });
    for (const tag of tags) this.renderRow(list, tag);
  }

  private renderRow(list: HTMLElement, tag: DidaTag): void {
    const row = list.createDiv({ cls: "dida-tagm-row" });
    const dot = row.createSpan({ cls: "dida-tagm-dot" });
    if (tag.color) dot.style.background = tag.color;
    if (this.editing === tag.name) {
      const input = row.createEl("input", { type: "text", cls: "dida-tagm-input", attr: { "aria-label": "新标签名" } });
      input.value = tag.label;
      window.setTimeout(() => input.select(), 0);
      const commit = (): void => void this.rename(tag, input.value.trim());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.editing = null;
          this.render();
        }
      });
      this.button(row, "check", "保存", commit);
      return;
    }
    row.createSpan({ cls: "dida-tagm-name", text: tag.label });
    if (tag.parent) row.createSpan({ cls: "dida-tagm-parent", text: `属于 ${this.plugin.tagLabel(tag.parent)}` });
    this.button(row, "pencil", "改名", () => {
      this.editing = tag.name;
      this.render();
    });
    const armed = this.armed === tag.name;
    const del = this.button(row, "trash-2", armed ? "再点一次删除" : "删除", () => {
      if (!armed) {
        this.armed = tag.name;
        window.clearTimeout(this.armTimer);
        this.armTimer = window.setTimeout(() => {
          this.armed = null;
          this.render();
        }, 3000);
        this.render();
        return;
      }
      void this.remove(tag);
    });
    del.addClass("is-danger");
    if (armed) {
      del.addClass("is-armed");
      del.createSpan({ text: "确认删除" });
    }
  }

  private button(parent: HTMLElement, icon: string, label: string, run: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "dida-tagm-btn", attr: { type: "button", "aria-label": label, title: label } });
    setIcon(b, icon);
    b.addEventListener("click", () => {
      if (!this.busy) run();
    });
    return b;
  }

  private async rename(tag: DidaTag, next: string): Promise<void> {
    if (!next || next === tag.label) {
      this.editing = null;
      this.render();
      return;
    }
    if (BAD_CHARS.test(next)) {
      new Notice("标签名不能有空格，也不能有 \\ / \" # : * ? < > |");
      return;
    }
    this.busy = true;
    try {
      await this.plugin.store.renameTag(tag.name, next);
      new Notice(`已把「${tag.label}」改成「${next}」`);
      this.editing = null;
    } catch (error) {
      new Notice(`改名失败：${this.plugin.describeError(error)}`, 6000);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async remove(tag: DidaTag): Promise<void> {
    this.busy = true;
    window.clearTimeout(this.armTimer);
    try {
      await this.plugin.store.deleteTag(tag.name);
      new Notice(`已删除标签「${tag.label}」`);
    } catch (error) {
      new Notice(`删除失败：${this.plugin.describeError(error)}`, 6000);
    } finally {
      this.armed = null;
      this.busy = false;
      this.render();
    }
  }
}
