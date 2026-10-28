import { Keymap, MarkdownRenderer, type App, type Component } from "obsidian";
import { obsidianLinksToWikilinks } from "../dida/deeplink.ts";
import { separateListLines, toggleTaskLine } from "../dida/taskList.ts";

/**
 * 渲染任务正文。比直接 MarkdownRenderer.render 多做三件事：
 * - 指向本 vault 的 obsidian:// 链接改成内部链接，显示成笔记名（不带外链图标），点了在 Obsidian 里打开；
 * - 内部链接的点击自己接（不在笔记视图里，Obsidian 不会替我们处理），⌘ / Ctrl 点开新页签；
 * - 列表项后面紧跟的普通行另起一段（滴答里一行就是一段，见 separateListLines）；
 * - 任务列表的勾选框能点，点了把正文里对应那行改掉，交给 onToggle 保存；不给 onToggle 就只读。
 * 同一个容器重复渲染时监听只挂一次。
 */
export function renderTaskMarkdown(app: App, source: string, el: HTMLElement, owner: Component, onToggle?: (next: string) => void): void {
  el.empty();
  el.addClass("dida-md");
  void MarkdownRenderer.render(app, separateListLines(obsidianLinksToWikilinks(source)), el, "", owner).then(() => {
    el.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox").forEach((box) => (box.disabled = !onToggle));
  });
  const state = el as HTMLElement & { didaMd?: { source: string; onToggle?: (next: string) => void } };
  const fresh = !state.didaMd;
  state.didaMd = { source, onToggle };
  if (!fresh) return;
  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>("a.internal-link");
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const href = link.dataset.href ?? link.getAttribute("href") ?? "";
      if (href) void app.workspace.openLinkText(href, "", Keymap.isModEvent(e));
      return;
    }
    if (target instanceof HTMLInputElement && target.hasClass("task-list-item-checkbox")) {
      e.stopPropagation();
      const current = state.didaMd;
      if (!current?.onToggle) return;
      const boxes = Array.from(el.querySelectorAll("input.task-list-item-checkbox"));
      const next = toggleTaskLine(current.source, boxes.indexOf(target));
      if (next !== null) current.onToggle(next);
    }
  });
}
