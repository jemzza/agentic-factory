import type { Task, TaskStatus } from "../domain/task.js";

export interface TaskListFilter {
  status?: TaskStatus;
  /** Include soft-deleted tasks. Defaults to `false`. */
  includeDeleted?: boolean;
}

/**
 * Persistence boundary for tasks. Implementations must return copies, so callers
 * can never mutate stored state without calling `save`.
 */
export interface TaskRepository {
  insert(task: Task): Promise<void>;
  /** Returns the task even if it is soft-deleted, or `null` if it never existed. */
  findById(id: string): Promise<Task | null>;
  /** Returns tasks in creation order (oldest first). */
  list(filter?: TaskListFilter): Promise<Task[]>;
  /** Replaces an existing task. Throws if the task does not exist. */
  save(task: Task): Promise<void>;
}
