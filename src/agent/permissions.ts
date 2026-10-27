/**
 * 对话框里 AI 能用的工具分三档：
 *   allow   查询类、单条新建 / 更新 / 完成、读 vault 笔记 —— 自动放行
 *   confirm 删除、批量、跨项目移动、改项目结构 —— 弹确认框
 *   deny    文件写入、Shell、联网 —— 这个对话框只管滴答
 * 纯函数，不依赖 Obsidian，可单测。
 */
export const DIDA_MCP_NAME = "dida365";
const DIDA_PREFIX = `mcp__${DIDA_MCP_NAME}__`;

export type ToolDecision = "allow" | "confirm" | "deny";

const AUTO_ALLOW_DIDA = new Set([
  "list_projects",
  "list_project_groups",
  "get_project_by_id",
  "get_project_with_undone_tasks",
  "list_columns",
  "list_tags",
  "filter_tasks",
  "list_undone_tasks_by_date",
  "list_undone_tasks_by_time_query",
  "list_completed_tasks_by_date",
  "search",
  "search_task",
  "fetch",
  "get_task_by_id",
  "get_task_in_project",
  "get_user_preference",
  "list_project_members",
  "list_habits",
  "list_habit_sections",
  "get_habit",
  "get_habit_checkins",
  "list_countdowns",
  "list_calendar_accounts",
  "query_calendar_events",
  "get_comment",
  "get_focus",
  "get_focuses_by_time",
  "create_task",
  "update_task",
  "complete_task",
  "complete_checklist_item",
  "create_tag",
  "add_comment"
]);

const BUILTIN_ALLOW = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);

const BUILTIN_DENY = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "KillShell", "BashOutput"];

/** 一回合里自动放行的 update_task 次数上限，超过就开始弹确认。 */
export const UPDATE_SOFT_LIMIT = 5;

export function didaToolName(toolName: string): string | null {
  return toolName.startsWith(DIDA_PREFIX) ? toolName.slice(DIDA_PREFIX.length) : null;
}

export function classifyTool(toolName: string): ToolDecision {
  const dida = didaToolName(toolName);
  if (dida !== null) return AUTO_ALLOW_DIDA.has(dida) ? "allow" : "confirm";
  if (BUILTIN_ALLOW.has(toolName)) return "allow";
  return "deny";
}

export function allowedToolPatterns(): string[] {
  return [...[...AUTO_ALLOW_DIDA].map((n) => `${DIDA_PREFIX}${n}`), ...BUILTIN_ALLOW];
}

export function disallowedTools(): string[] {
  return [...BUILTIN_DENY];
}

export interface ToolCallDescription {
  title: string;
  lines: string[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
}

/** 确认框文案。titleOf 由调用方提供，用任务 id 查标题。 */
export function describeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  titleOf: (taskId: string) => string | null = () => null
): ToolCallDescription {
  const dida = didaToolName(toolName) ?? toolName;
  const name = (id: unknown): string => {
    const s = str(id);
    return titleOf(s) ?? s;
  };
  switch (dida) {
    case "delete_task":
      return { title: "删除待办", lines: [name(input.task_id)] };
    case "complete_tasks_in_project": {
      const ids = Array.isArray(input.task_ids) ? input.task_ids : [];
      return { title: `完成 ${ids.length} 条待办`, lines: ids.map(name) };
    }
    case "batch_update_tasks": {
      const tasks = asList(input.tasks);
      return { title: `批量更新 ${tasks.length} 条待办`, lines: tasks.map((t) => str(t.title) || name(t.id)) };
    }
    case "batch_add_tasks": {
      const tasks = asList(input.tasks);
      return { title: `批量新建 ${tasks.length} 条待办`, lines: tasks.map((t) => str(t.title)) };
    }
    case "move_task": {
      const moves = asList(input.moves);
      return { title: `跨项目移动 ${moves.length} 条待办`, lines: moves.map((m) => name(m.taskId)) };
    }
    case "update_task":
      return { title: "更新待办（本回合已超过自动放行次数）", lines: [name(input.task_id)] };
    case "create_project":
      return { title: "新建项目", lines: [str(input.name) || JSON.stringify(input)] };
    case "update_project":
      return { title: "修改项目", lines: [str(input.name) || str(input.project_id)] };
    case "delete_tag":
    case "rename_tag":
    case "update_tag":
      return { title: `标签操作：${dida}`, lines: [JSON.stringify(input)] };
    case "delete_project_group":
    case "create_project_group":
    case "update_project_group":
      return { title: `项目组操作：${dida}`, lines: [JSON.stringify(input)] };
    default:
      return { title: `执行 ${dida}`, lines: [JSON.stringify(input).slice(0, 400)] };
  }
}

/** 工具步骤行的简短标签。 */
export function toolLabel(toolName: string, input: Record<string, unknown>): string {
  const dida = didaToolName(toolName);
  if (dida === null) {
    if (toolName === "Read") return `读笔记 ${str(input.file_path).split("/").pop() ?? ""}`.trim();
    return toolName;
  }
  const filter = typeof input.filter === "object" && input.filter !== null ? (input.filter as Record<string, unknown>) : {};
  const task = typeof input.task === "object" && input.task !== null ? (input.task as Record<string, unknown>) : {};
  switch (dida) {
    case "list_projects":
      return "查项目列表";
    case "list_project_groups":
      return "查项目分组";
    case "get_project_with_undone_tasks":
      return "查项目里的待办";
    case "list_columns":
      return "查看板列";
    case "list_tags":
      return "查标签";
    case "filter_tasks":
      return Array.isArray(filter.tag) && filter.tag.length ? `按标签筛选：${filter.tag.join("、")}` : "筛选待办";
    case "list_undone_tasks_by_time_query":
      return `查${str(input.query_command) === "today" ? "今天" : str(input.query_command) === "tomorrow" ? "明天" : "近期"}的待办`;
    case "list_undone_tasks_by_date":
      return "按日期查待办";
    case "list_completed_tasks_by_date":
      return "查已完成";
    case "search":
    case "search_task":
      return `搜索「${str(input.query)}」`;
    case "get_task_by_id":
    case "get_task_in_project":
      return "读取待办详情";
    case "create_task":
      return `新建：${str(task.title)}`;
    case "update_task":
      return `更新：${str(task.title) || str(input.task_id)}`;
    case "complete_task":
      return "标记完成";
    case "delete_task":
      return "删除待办";
    case "batch_add_tasks":
      return `批量新建 ${asList(input.tasks).length} 条`;
    case "batch_update_tasks":
      return `批量更新 ${asList(input.tasks).length} 条`;
    case "complete_tasks_in_project":
      return `批量完成 ${Array.isArray(input.task_ids) ? input.task_ids.length : 0} 条`;
    case "move_task":
      return `移动 ${asList(input.moves).length} 条到别的项目`;
    default:
      return dida;
  }
}
