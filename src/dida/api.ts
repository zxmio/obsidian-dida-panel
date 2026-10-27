import { isGatewayError, type McpClient } from "../mcp/client.ts";
import { isRecord } from "../mcp/protocol.ts";
import { addDays, formatDidaDate, localTimeZone, startOfDay } from "./dates.ts";
import { asArray, normalizeColumn, normalizeGroup, normalizeProject, normalizeSearchHit, normalizeTag, normalizeTask, str, unwrapResult } from "./normalize.ts";
import type { DidaColumn, DidaProject, DidaProjectGroup, DidaTag, DidaTask, TaskInput, TaskSearchHit } from "./types.ts";

export interface ProjectBundle {
  project: DidaProject;
  tasks: DidaTask[];
  columns: DidaColumn[];
}

/** 滴答 MCP 工具的强类型封装。工具名与参数对照 ~/.claude/skills/dida365 的记录。 */
export class DidaApi {
  private readonly client: McpClient;

  constructor(client: McpClient) {
    this.client = client;
  }

  private get tz(): string {
    return localTimeZone();
  }

  async listProjects(): Promise<DidaProject[]> {
    const raw = await this.client.callTool("list_projects", {});
    return asArray(raw).map(normalizeProject);
  }

  async listProjectGroups(): Promise<DidaProjectGroup[]> {
    const raw = await this.client.callTool("list_project_groups", {});
    return asArray(raw).map(normalizeGroup).filter((g) => g.id);
  }

  async getProjectWithTasks(projectId: string): Promise<ProjectBundle> {
    const raw = await this.client.callTool("get_project_with_undone_tasks", { project_id: projectId });
    const obj = isRecord(raw) ? raw : {};
    const projectRaw = isRecord(obj.project) ? obj.project : { id: projectId, name: projectId };
    return {
      project: normalizeProject(projectRaw),
      tasks: asArray(obj.tasks).map(normalizeTask),
      columns: asArray(obj.columns).map(normalizeColumn).sort((a, b) => a.sortOrder - b.sortOrder)
    };
  }

  async listColumns(projectId: string): Promise<DidaColumn[]> {
    const raw = await this.client.callTool("list_columns", { project_id: projectId });
    return asArray(raw).map(normalizeColumn).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async listTodayTasks(): Promise<DidaTask[]> {
    const raw = await this.client.callTool("list_undone_tasks_by_time_query", {
      query_command: "today",
      client_timezone: this.tz
    });
    return asArray(raw).map(normalizeTask);
  }

  /** 全部未完成任务（跨所有项目，含收件箱），一次调用，用来算项目总览的数字。 */
  /**
   * 全部未完成任务。任务多时一次全量查询会被网关超时（502），
   * 这时按优先级拆成四次小查询再合并。
   */
  async listAllUndoneTasks(): Promise<DidaTask[]> {
    const query = async (filter: Record<string, unknown>): Promise<DidaTask[]> =>
      asArray(await this.client.callTool("filter_tasks", { client_timezone: this.tz, filter })).map(normalizeTask);
    try {
      return await query({ status: [0] });
    } catch (error) {
      if (!isGatewayError(error)) throw error;
      const parts: DidaTask[][] = [];
      for (const p of [0, 1, 3, 5]) parts.push(await query({ status: [0], priority: [p] }));
      const byId = new Map<string, DidaTask>();
      for (const t of parts.flat()) byId.set(t.id, t);
      return Array.from(byId.values());
    }
  }

  /** 过期任务：最近 90 天内排了期、截止早于今天、仍未完成的。 */
  async listOverdueTasks(now: Date = new Date()): Promise<DidaTask[]> {
    const today = startOfDay(now);
    const raw = await this.client.callTool("filter_tasks", {
      client_timezone: this.tz,
      filter: {
        startDate: formatDidaDate(addDays(today, -90), true),
        endDate: formatDidaDate(today, true),
        status: [0]
      }
    });
    return asArray(raw)
      .map(normalizeTask)
      .filter((t) => {
        const due = t.dueDate ?? t.startDate;
        if (!due) return false;
        const d = new Date(due);
        return !Number.isNaN(d.getTime()) && d.getTime() < today.getTime();
      });
  }

  async listCompletedTasks(from: Date, to: Date): Promise<DidaTask[]> {
    const raw = await this.client.callTool("list_completed_tasks_by_date", {
      client_timezone: this.tz,
      search: { startDate: formatDidaDate(from, false), endDate: formatDidaDate(to, false) }
    });
    return asArray(raw).map(normalizeTask);
  }

  async listTags(): Promise<DidaTag[]> {
    const raw = await this.client.callTool("list_tags", {});
    return asArray(raw).map(normalizeTag).filter((t) => t.name);
  }

  async searchTasks(query: string): Promise<TaskSearchHit[]> {
    const raw = await this.client.callTool("search_task", { query });
    const list = asArray(isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : raw);
    return list.map(normalizeSearchHit).filter((h) => h.id);
  }

  async getTask(taskId: string): Promise<DidaTask> {
    const raw = await this.client.callTool("get_task_by_id", { task_id: taskId });
    const obj = unwrapResult(raw);
    if (!isRecord(obj)) throw new Error("没有找到这条任务");
    return normalizeTask(obj);
  }

  async createTask(input: TaskInput): Promise<DidaTask> {
    const raw = await this.client.callTool("create_task", {
      client_timezone: this.tz,
      task: this.toPayload(input)
    });
    const obj = unwrapResult(raw);
    if (!isRecord(obj)) throw new Error("创建成功但接口没有返回任务");
    return normalizeTask(obj);
  }

  async updateTask(task: DidaTask, patch: Partial<TaskInput> & { status?: DidaTask["status"] }): Promise<DidaTask> {
    const payload: Record<string, unknown> = {
      id: task.id,
      projectId: patch.projectId ?? task.projectId,
      ...this.toPayload(patch)
    };
    if (task.etag) payload.etag = task.etag;
    if (patch.status !== undefined) payload.status = patch.status;
    const raw = await this.client.callTool("update_task", {
      client_timezone: this.tz,
      task_id: task.id,
      task: payload
    });
    const obj = unwrapResult(raw);
    return isRecord(obj) && str(obj.id) ? normalizeTask(obj) : { ...task, ...patch, etag: null };
  }

  async completeTask(task: DidaTask): Promise<void> {
    await this.client.callTool("complete_task", { project_id: task.projectId, task_id: task.id });
  }

  async deleteTask(task: DidaTask): Promise<void> {
    await this.client.callTool("delete_task", { project_id: task.projectId, task_id: task.id });
  }

  async moveTask(task: DidaTask, toProjectId: string): Promise<void> {
    await this.client.callTool("move_task", {
      moves: [{ taskId: task.id, fromProjectId: task.projectId, toProjectId }]
    });
  }

  private toPayload(input: Partial<TaskInput>): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (input.title !== undefined) payload.title = input.title;
    if (input.projectId !== undefined) payload.projectId = input.projectId;
    if (input.columnId !== undefined && input.columnId !== null) payload.columnId = input.columnId;
    if (input.priority !== undefined) payload.priority = input.priority;
    if (input.tags !== undefined) payload.tags = input.tags;
    if (input.content !== undefined) payload.content = input.content;
    if (input.startDate !== undefined) payload.startDate = input.startDate;
    if (input.dueDate !== undefined) payload.dueDate = input.dueDate;
    if (input.isAllDay !== undefined) payload.isAllDay = input.isAllDay;
    if (input.startDate || input.dueDate) payload.timeZone = input.timeZone ?? this.tz;
    return payload;
  }
}
