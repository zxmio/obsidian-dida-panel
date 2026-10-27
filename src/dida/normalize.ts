import { isRecord } from "../mcp/protocol.ts";
import { INBOX_ID, isInboxId, toPriority, type DidaColumn, type DidaProject, type DidaProjectGroup, type DidaTag, type DidaTask, type TaskSearchHit } from "./types.ts";

/**
 * 滴答 MCP 各工具的返回结构并不统一：有的包一层 {result:[…]}，有的直接给对象，
 * 按时间查询的接口还用 snake_case 字段。这里统一归一化成 camelCase 的强类型对象。
 * 纯函数，不依赖 Obsidian，方便单测。
 */
function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[toCamel(k)] = camelize(v);
    return out;
  }
  return value;
}

export function unwrapResult(value: unknown): unknown {
  if (isRecord(value) && "result" in value && Object.keys(value).length === 1) return value.result;
  return value;
}

export function asArray(value: unknown): Record<string, unknown>[] {
  const v = unwrapResult(value);
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

export function normalizeTask(raw: Record<string, unknown>): DidaTask {
  const t = camelize(raw) as Record<string, unknown>;
  const status = t.status === 2 ? 2 : t.status === -1 ? -1 : 0;
  const kind = t.kind === "NOTE" || t.kind === "CHECKLIST" ? t.kind : t.kind === "TEXT" ? "TEXT" : null;
  return {
    id: str(t.id) ?? "",
    projectId: str(t.projectId) ?? INBOX_ID,
    title: str(t.title) ?? "",
    content: str(t.content),
    desc: str(t.desc),
    startDate: str(t.startDate),
    dueDate: str(t.dueDate),
    timeZone: str(t.timeZone),
    isAllDay: typeof t.isAllDay === "boolean" ? t.isAllDay : null,
    priority: toPriority(t.priority),
    status,
    tags: strList(t.tags),
    columnId: str(t.columnId),
    columnName: str(t.columnName),
    parentId: str(t.parentId),
    childIds: strList(t.childIds),
    etag: str(t.etag),
    kind,
    completedTime: str(t.completedTime),
    createdTime: str(t.createdTime),
    modifiedTime: str(t.modifiedTime),
    repeatFlag: str(t.repeatFlag),
    sortOrder: typeof t.sortOrder === "number" ? t.sortOrder : null
  };
}

export function normalizeProject(raw: Record<string, unknown>): DidaProject {
  const p = camelize(raw) as Record<string, unknown>;
  const viewMode = p.viewMode === "kanban" || p.viewMode === "timeline" ? p.viewMode : "list";
  const id = str(p.id) ?? "";
  return {
    id: isInboxId(id) ? INBOX_ID : id,
    name: isInboxId(id) ? "收件箱" : str(p.name) ?? "（未命名）",
    color: str(p.color),
    closed: typeof p.closed === "boolean" ? p.closed : null,
    groupId: str(p.groupId),
    viewMode,
    kind: str(p.kind) ?? "TASK"
  };
}

export function normalizeGroup(raw: Record<string, unknown>): DidaProjectGroup {
  const g = camelize(raw) as Record<string, unknown>;
  return { id: str(g.id) ?? "", name: str(g.name) ?? "" };
}

export function normalizeColumn(raw: Record<string, unknown>): DidaColumn {
  const c = camelize(raw) as Record<string, unknown>;
  return {
    id: str(c.id) ?? "",
    projectId: str(c.projectId) ?? "",
    name: str(c.name) ?? "",
    sortOrder: typeof c.sortOrder === "number" ? c.sortOrder : 0
  };
}

export function normalizeTag(raw: Record<string, unknown>): DidaTag {
  const t = camelize(raw) as Record<string, unknown>;
  const name = str(t.name) ?? "";
  return { name, label: str(t.label) ?? name, color: str(t.color), parent: str(t.parent) || null };
}

export function normalizeSearchHit(raw: Record<string, unknown>): TaskSearchHit {
  const h = camelize(raw) as Record<string, unknown>;
  return {
    id: str(h.taskId) ?? str(h.id) ?? "",
    title: str(h.title) ?? "",
    projectId: str(h.projectId),
    url: str(h.url)
  };
}
