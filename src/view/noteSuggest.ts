import { FuzzySuggestModal, type App, type TFile } from "obsidian";

/** 从 vault 里挑一篇笔记：当前打开的排第一，其余按最近修改排。 */
export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    placeholder: string,
    private readonly onChoose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): TFile[] {
    const active = this.app.workspace.getActiveFile();
    const files = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    return active ? [active, ...files.filter((f) => f !== active)] : files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}
