import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type DidaPanelPlugin from "./main.ts";
import type { OAuthTokens } from "./mcp/oauth.ts";
import type { CompletedRange } from "./store.ts";
import { DISPATCH_TARGETS, isDispatchTarget, type DispatchTarget } from "./dispatch/targets.ts";
import { INBOX_ID } from "./dida/types.ts";
import { DEFAULT_DISPATCH_TEMPLATE } from "./dispatch/prompt.ts";
import { findClaudeExecutable } from "./agent/process.ts";

export type PanelTab = "today" | "inbox" | "project" | "search";
export type ProjectViewMode = "list" | "board";

export interface DidaSettings {
  /** 每个项目上次用的显示方式（列表 / 看板），按项目 id 记。 */
  viewModes: Record<string, ProjectViewMode>;
  endpoint: string;
  tokens: OAuthTokens | null;
  manualToken: string;
  defaultProjectId: string;
  defaultView: PanelTab;
  lastProjectId: string | null;
  /** 置顶到顶部页签栏的项目，按置顶先后排 */
  pinnedProjects: string[];
  refreshMinutes: number;
  openOnStartup: boolean;
  vaultName: string;
  hideSeparators: boolean;
  completedRange: CompletedRange;
  /** 派给 AI：默认去处、Claude Code / Codex 的工作目录（空=vault）、队列标签、指令模板、是否新建会话 */
  aiTarget: DispatchTarget;
  aiWorkdir: string;
  aiTag: string;
  aiPromptTemplate: string;
  aiNewConversation: boolean;
  /** 底部 AI 对话框：claude 可执行文件路径（空=自动找）、模型（空=默认） */
  claudePath: string;
  claudeModel: string;
}

export const DEFAULT_SETTINGS: DidaSettings = {
  viewModes: {},
  endpoint: "https://mcp.dida365.com",
  tokens: null,
  manualToken: "",
  defaultProjectId: INBOX_ID,
  defaultView: "today",
  lastProjectId: null,
  pinnedProjects: [],
  refreshMinutes: 5,
  openOnStartup: false,
  vaultName: "",
  hideSeparators: true,
  completedRange: "today",
  aiTarget: "makerpilot",
  aiWorkdir: "",
  aiTag: "派给AI",
  aiPromptTemplate: DEFAULT_DISPATCH_TEMPLATE,
  aiNewConversation: true,
  claudePath: "",
  claudeModel: ""
};

export class DidaSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DidaPanelPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "在 Obsidian 里增删改查滴答清单待办。所有数据都在滴答，插件不另存一份。"
    });

    new Setting(containerEl).setName("连接").setHeading();

    new Setting(containerEl)
      .setName("MCP 服务地址")
      .setDesc("滴答清单 MCP 的 HTTP 端点。改了地址要重新登录。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.endpoint)
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim() || DEFAULT_SETTINGS.endpoint;
            await this.plugin.saveSettings();
            this.plugin.client.reset();
          })
      );

    const status = this.plugin.connectionStatus();
    new Setting(containerEl)
      .setName("账号")
      .setDesc(status)
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.isLoggedIn() ? "重新登录" : "登录滴答清单")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.login();
            } finally {
              this.display();
            }
          })
      )
      .addButton((btn) =>
        btn.setButtonText("测试连接").onClick(async () => {
          btn.setDisabled(true);
          try {
            const projects = await this.plugin.store.loadProjects(true);
            new Notice(`已连接，${projects.length - 1} 个活跃项目`);
          } catch (error) {
            new Notice(`连接失败：${this.plugin.describeError(error)}`);
          } finally {
            btn.setDisabled(false);
            this.display();
          }
        })
      )
      .addButton((btn) =>
        btn.setButtonText("退出登录").onClick(async () => {
          await this.plugin.logout();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("访问令牌（可选）")
      .setDesc("已有 Bearer 令牌可直接粘贴，优先于浏览器登录。只保存在本机插件数据里。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.style.width = "260px";
        text
          .setPlaceholder("留空则使用浏览器登录")
          .setValue(this.plugin.settings.manualToken)
          .onChange(async (value) => {
            this.plugin.settings.manualToken = value.trim();
            await this.plugin.saveSettings();
            this.plugin.client.reset();
            this.plugin.store.invalidateAll();
          });
      });

    new Setting(containerEl).setName("默认行为").setHeading();

    new Setting(containerEl)
      .setName("新建待办默认项目")
      .setDesc("快速添加时不指定项目，就进这里。")
      .addDropdown((dd) => {
        const projects = this.plugin.store.projects;
        if (projects.length === 0) dd.addOption(INBOX_ID, "收件箱");
        for (const p of projects) dd.addOption(p.id, p.name);
        if (!projects.some((p) => p.id === this.plugin.settings.defaultProjectId)) {
          this.plugin.settings.defaultProjectId = INBOX_ID;
        }
        dd.setValue(this.plugin.settings.defaultProjectId).onChange(async (value) => {
          this.plugin.settings.defaultProjectId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("面板默认视图").addDropdown((dd) =>
      dd
        .addOptions({ today: "今天", inbox: "收件箱", project: "项目总览" })
        .setValue(this.plugin.settings.defaultView)
        .onChange(async (value) => {
          this.plugin.settings.defaultView = value as PanelTab;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl)
      .setName("自动刷新间隔")
      .setDesc("面板可见时按此间隔重新拉取；手动操作后立即刷新。")
      .addDropdown((dd) =>
        dd
          .addOptions({ "1": "1 分钟", "5": "5 分钟", "15": "15 分钟", "0": "关闭" })
          .setValue(String(this.plugin.settings.refreshMinutes))
          .onChange(async (value) => {
            this.plugin.settings.refreshMinutes = Number(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("启动时打开面板").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.openOnStartup).onChange(async (value) => {
        this.plugin.settings.openOnStartup = value;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("笔记联动").setHeading();

    new Setting(containerEl)
      .setName("Vault 名称")
      .setDesc("生成深链时用，留空则取当前库名。")
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("AI 对话框").setHeading();

    const detected = findClaudeExecutable(this.plugin.settings.claudePath);
    new Setting(containerEl)
      .setName("Claude Code 路径")
      .setDesc(detected ? `当前使用：${detected}` : "没找到 claude。填绝对路径，或确认它在 PATH 里。")
      .addText((text) => {
        text.inputEl.style.width = "280px";
        text
          .setPlaceholder("留空自动查找")
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (value) => {
            this.plugin.settings.claudePath = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("重新检测").onClick(() => {
          const found = findClaudeExecutable(this.plugin.settings.claudePath);
          new Notice(found ? `找到了：${found}` : "没找到 claude");
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("对话框使用的模型")
      .setDesc("留空用 Claude Code 的默认模型。")
      .addText((text) =>
        text
          .setPlaceholder("例如 claude-sonnet-5-5")
          .setValue(this.plugin.settings.claudeModel)
          .onChange(async (value) => {
            this.plugin.settings.claudeModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("派给 AI").setHeading();

    new Setting(containerEl)
      .setName("队列标签")
      .setDesc("点「派给 AI」会给待办打上这个标签。Claude Code 的领活循环按这个标签取任务。")
      .addText((text) =>
        text.setValue(this.plugin.settings.aiTag).onChange(async (value) => {
          this.plugin.settings.aiTag = value.trim() || DEFAULT_SETTINGS.aiTag;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("默认派给")
      .setDesc("点任务上的机器人图标时打开哪里。任务菜单里可以临时换。Claude Code、Claude 对话需要 Claude 桌面 App，Codex 需要 ChatGPT 桌面 App；打开后只填好指令，不会自动发送。")
      .addDropdown((dd) => {
        for (const t of DISPATCH_TARGETS) dd.addOption(t.id, t.label);
        dd.setValue(this.plugin.settings.aiTarget).onChange(async (value) => {
          if (isDispatchTarget(value)) this.plugin.settings.aiTarget = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("工作目录")
      .setDesc("Claude Code 和 Codex 新会话在哪个文件夹里开。留空就是这个 vault。")
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.vaultPath() || "vault 所在目录")
          .setValue(this.plugin.settings.aiWorkdir)
          .onChange(async (value) => {
            this.plugin.settings.aiWorkdir = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("派活时在 MakerPilot 新建会话")
      .setDesc("关掉则把指令追加到当前会话的输入框。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.aiNewConversation).onChange(async (value) => {
          this.plugin.settings.aiNewConversation = value;
          await this.plugin.saveSettings();
        })
      );

    const tpl = new Setting(containerEl)
      .setName("指令模板")
      .setDesc("占位符：{{title}} {{project}} {{column}} {{due}} {{priority}} {{tags}} {{notes}} {{links}}。空值所在的行会自动收掉。")
      .addTextArea((area) => {
        area.inputEl.rows = 10;
        area.inputEl.style.width = "100%";
        area.inputEl.style.fontFamily = "var(--font-monospace)";
        area.setValue(this.plugin.settings.aiPromptTemplate).onChange(async (value) => {
          this.plugin.settings.aiPromptTemplate = value;
          await this.plugin.saveSettings();
        });
      })
      .addExtraButton((btn) =>
        btn
          .setIcon("rotate-ccw")
          .setTooltip("恢复默认模板")
          .onClick(async () => {
            this.plugin.settings.aiPromptTemplate = DEFAULT_DISPATCH_TEMPLATE;
            await this.plugin.saveSettings();
            this.display();
          })
      );
    tpl.settingEl.addClass("dida-setting-stack");

    new Setting(containerEl).setName("显示").setHeading();

    new Setting(containerEl)
      .setName("隐藏分隔符项目")
      .setDesc("名字只有方块符号的空项目不出现在项目列表里。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideSeparators).onChange(async (value) => {
          this.plugin.settings.hideSeparators = value;
          await this.plugin.saveSettings();
          this.plugin.store.invalidateAll();
        })
      );

    new Setting(containerEl).setName("已完成任务显示范围").addDropdown((dd) =>
      dd
        .addOptions({ today: "仅今天完成的", week: "最近 7 天", none: "不显示" })
        .setValue(this.plugin.settings.completedRange)
        .onChange(async (value) => {
          this.plugin.settings.completedRange = value as CompletedRange;
          await this.plugin.saveSettings();
          this.plugin.store.invalidateAll();
        })
    );
  }
}
