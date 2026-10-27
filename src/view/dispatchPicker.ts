import type DidaPanelPlugin from "../main.ts";
import { isQueued } from "../dispatch/prompt.ts";
import { DISPATCH_TARGETS, type DispatchTarget } from "../dispatch/targets.ts";
import type { DidaTask } from "../dida/types.ts";
import { QuickPopover } from "./quickPopover.ts";

/**
 * 「派给哪个 AI」面板：四个去处带各自 logo，按 1-4 直选，默认的标出来，其余悬停可设为默认，用不了的灰掉；
 * 底部是只进队列 / 移出队列。rect 是锚点位置（按钮或鼠标处）。
 */
export function openDispatchPicker(plugin: DidaPanelPlugin, task: DidaTask, doc: Document, rect: DOMRect): QuickPopover {
  const run = (target: DispatchTarget | "none"): void => {
    pop.close();
    void plugin.dispatchTask(task, target);
  };
  const pop: QuickPopover = new QuickPopover(doc, rect, {
    cls: "is-dispatch",
    render: (p, body) => {
      const settings = plugin.settings;
      const head = body.createDiv({ cls: "dida-pop-head" });
      head.createSpan({ cls: "dida-pop-head-title", text: "派给哪个 AI" });
      head.createSpan({ cls: "dida-pop-head-task", text: task.title });

      const sec = p.section(body);
      DISPATCH_TARGETS.forEach((t, i) => {
        const ok = plugin.dispatchAvailable(t.id);
        const isDefault = t.id === settings.aiTarget;
        p.item(sec, {
          icon: t.icon,
          logo: t.logo,
          label: t.label,
          badge: !ok ? (t.id === "makerpilot" ? "未启用" : "未安装") : isDefault ? "默认" : undefined,
          action:
            ok && !isDefault
              ? {
                  label: "设为默认",
                  run: () => {
                    settings.aiTarget = t.id;
                    void plugin.saveSettings();
                    p.refresh();
                  }
                }
              : undefined,
          hint: String(i + 1),
          disabled: !ok,
          cls: `is-target is-${t.id}`,
          onSelect: () => run(t.id)
        });
      });

      const foot = p.section(body);
      const queued = isQueued(task, settings.aiTag);
      p.item(foot, {
        icon: queued ? "list-x" : "list-plus",
        label: queued ? "移出 AI 队列" : "只进 AI 队列，先不打开",
        cls: "is-muted",
        onSelect: () => {
          pop.close();
          void (queued ? plugin.undispatchTask(task) : plugin.dispatchTask(task, "none"));
        }
      });
    },
    onKey: (key) => {
      const t = DISPATCH_TARGETS[Number(key) - 1];
      if (!t || !plugin.dispatchAvailable(t.id)) return false;
      run(t.id);
      return true;
    },
    onClose: () => {}
  });
  return pop;
}
