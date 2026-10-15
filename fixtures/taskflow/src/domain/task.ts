export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Set when the task is soft-deleted; `null` while the task is active. */
  deletedAt: Date | null;
}

/** JSON representation returned by the HTTP API (dates as ISO-8601 strings). */
export interface TaskDto {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function toTaskDto(task: Task): TaskDto {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    deletedAt: task.deletedAt ? task.deletedAt.toISOString() : null,
  };
}

export function isDeleted(task: Task): boolean {
  return task.deletedAt !== null;
}
