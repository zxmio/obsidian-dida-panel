export type Priority = 0 | 1 | 3 | 5;
export type TaskStatus = 0 | -1 | 2;

export interface DidaProject {
  id: string;
  name: string;
  color: string | null;
  closed: boolean | null;
  groupId: string | null;
  viewMode: "list" | "kanban" | "timeline";
  kind: string;
}

export interface DidaProjectGroup {
  id: string;
  name: string;
}

export interface DidaColumn {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
}

export interface DidaTag {
  name: string;
  label: string;
  color: string | null;
  parent: string | null;
}

export interface DidaTask {
  id: string;
  projectId: string;
  title: string;
  content: string | null;
  desc: string | null;
  startDate: string | null;
  dueDate: string | null;
  timeZone: string | null;
  isAllDay: boolean | null;
  priority: Priority;
  status: TaskStatus;
  tags: string[] | null;
  columnId: string | null;
  columnName?: string | null;
  parentId: string | null;
  childIds: string[] | null;
  etag: string | null;
  kind: "TEXT" | "NOTE" | "CHECKLIST" | null;
  completedTime: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  sortOrder?: number | null;
  /** 周期任务的 RRULE；非周期任务为空 */
  repeatFlag?: string | null;
}

export interface TaskSearchHit {
  id: string;
  title: string;
  projectId: string | null;
  url: string | null;
}

/** 新建或整体更新一条任务时的输入。 */
export interface TaskInput {
  title: string;
  projectId: string;
  columnId?: string | null;
  priority: Priority;
  tags: string[];
  content: string;
  startDate?: string | null;
  dueDate?: string | null;
  isAllDay?: boolean;
  timeZone?: string;
}

export const PRIORITY_LABEL: Record<Priority, string> = { 0: "无", 1: "低", 3: "中", 5: "高" };
export const PRIORITIES: Priority[] = [0, 1, 3, 5];

/** 面板内部用来指代收件箱的固定 id；接口返回的收件箱 id 形如 inbox1010437297。 */
export const INBOX_ID = "inbox";

export function isInboxId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("inbox");
}

export function toPriority(value: unknown): Priority {
  return value === 1 || value === 3 || value === 5 ? value : 0;
}
