import { FuzzySuggestModal, type App } from "obsidian";
import type { DidaProject } from "../dida/types.ts";
import type { DidaStore } from "../store.ts";

export class ProjectSuggestModal extends FuzzySuggestModal<DidaProject> {
  constructor(
    app: App,
    private readonly store: DidaStore,
    private readonly onChoose: (project: DidaProject) => void,
    private readonly exclude: string[] = []
  ) {
    super(app);
    this.setPlaceholder("输入项目名…");
  }

  getItems(): DidaProject[] {
    return this.store.projects.filter((p) => !this.exclude.includes(p.id));
  }

  getItemText(project: DidaProject): string {
    const group = this.store.groupName(project.groupId);
    return group ? `${project.name}  ·  ${group}` : project.name;
  }

  onChooseItem(project: DidaProject): void {
    this.onChoose(project);
  }
}
