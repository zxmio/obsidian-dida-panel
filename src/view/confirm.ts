import { Modal, type App } from "obsidian";

/** 删除、批量改期这类不可逆或影响多条的操作，先问一句。 */
export class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly resolve: (ok: boolean) => void,
    private readonly danger = false
  ) {
    super(app);
  }

  static ask(app: App, title: string, message: string, confirmText = "确定", danger = false): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, message, confirmText, resolve, danger).open());
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { cls: "dida-confirm-text", text: this.message });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const ok = row.createEl("button", { text: this.confirmText, cls: this.danger ? "mod-warning" : "mod-cta" });
    ok.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(true);
      this.close();
    });
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}
