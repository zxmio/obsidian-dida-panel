import { QuickPopover } from "./quickPopover.ts";

export interface ActionItem {
  icon: string;
  label: string;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  run: () => void;
}

export interface ActionMenuSpec {
  /** 顶部的标题区：图标（emoji 或留空）、名称、一行小字 */
  head?: { emoji?: string | null; title: string; sub?: string };
  /** 每组之间画一条分隔线；空组自动跳过 */
  groups: ActionItem[][];
}

/**
 * 通用的操作面板：代替 Obsidian 原生菜单，样式和任务操作、派送面板一致。
 * 选中一项先关面板再执行，免得动作里再弹窗时两层叠在一起。
 */
export function openActionMenu(doc: Document, rect: DOMRect, spec: ActionMenuSpec): QuickPopover {
  const pop: QuickPopover = new QuickPopover(doc, rect, {
    cls: "is-actions",
    render: (p, body) => {
      if (spec.head) {
        const head = body.createDiv({ cls: "dida-am-head" });
        if (spec.head.emoji) head.createSpan({ cls: "dida-am-emoji", text: spec.head.emoji });
        const text = head.createDiv({ cls: "dida-am-head-text" });
        text.createSpan({ cls: "dida-am-title", text: spec.head.title });
        if (spec.head.sub) text.createSpan({ cls: "dida-am-sub", text: spec.head.sub });
      }
      for (const group of spec.groups) {
        if (!group.length) continue;
        const sec = p.section(body);
        for (const item of group) {
          p.item(sec, {
            icon: item.icon,
            label: item.label,
            hint: item.hint,
            checked: item.checked,
            cls: item.danger ? "is-danger" : undefined,
            onSelect: () => {
              pop.close();
              item.run();
            }
          });
        }
      }
    },
    onClose: () => {}
  });
  return pop;
}

/**
 * 输入一个名称的小面板（重命名、新建分组）：输入框 + 一行「确定」，回车提交、Esc 取消。
 * 和操作面板同一套样式，不另起弹窗。
 */
export function openPrompt(
  doc: Document,
  rect: DOMRect,
  o: { title: string; placeholder: string; confirm: string; value?: string; onSubmit: (value: string) => void }
): QuickPopover {
  const pop: QuickPopover = new QuickPopover(doc, rect, {
    cls: "is-actions is-prompt",
    search: o.placeholder,
    initialQuery: o.value,
    render: (p, body, query) => {
      const sec = p.section(body, o.title);
      const value = query.trim();
      const unchanged = !!o.value && value === o.value.trim();
      p.item(sec, {
        icon: "check",
        label: value && !unchanged ? `${o.confirm}「${value}」` : "输入名称后回车",
        disabled: !value || unchanged,
        onSelect: () => {
          pop.close();
          o.onSubmit(value);
        }
      });
    },
    onClose: () => {}
  });
  return pop;
}
