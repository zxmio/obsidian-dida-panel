import { SuggestModal, type App } from "obsidian";
import type { DidaApi } from "../dida/api.ts";
import type { TaskSearchHit } from "../dida/types.ts";

/** 按关键字搜滴答里的任务，用于「把当前笔记关联到已有待办」。 */
export class TaskSuggestModal extends SuggestModal<TaskSearchHit> {
  private cache = new Map<string, TaskSearchHit[]>();

  constructor(app: App, private readonly api: DidaApi, private readonly onChoose: (hit: TaskSearchHit) => void) {
    super(app);
    this.setPlaceholder("输入关键字搜索待办…");
    this.emptyStateText = "没有匹配的待办";
  }

  async getSuggestions(query: string): Promise<TaskSearchHit[]> {
    const q = query.trim();
    if (q.length < 1) return [];
    const cached = this.cache.get(q);
    if (cached) return cached;
    try {
      const hits = await this.api.searchTasks(q);
      this.cache.set(q, hits);
      return hits;
    } catch {
      return [];
    }
  }

  renderSuggestion(hit: TaskSearchHit, el: HTMLElement): void {
    el.createDiv({ text: hit.title || "（无标题）" });
  }

  onChooseSuggestion(hit: TaskSearchHit): void {
    this.onChoose(hit);
  }
}
