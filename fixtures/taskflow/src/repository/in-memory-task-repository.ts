import type { Task } from "../domain/task.js";
import type { TaskListFilter, TaskRepository } from "./task-repository.js";

function clone(task: Task): Task {
  return {
    ...task,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    deletedAt: task.deletedAt ? new Date(task.deletedAt) : null,
  };
}

export class InMemoryTaskRepository implements TaskRepository {
  // Map preserves insertion order, which is creation order.
  private readonly tasks = new Map<string, Task>();

  async insert(task: Task): Promise<void> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists`);
    }
    this.tasks.set(task.id, clone(task));
  }

  async findById(id: string): Promise<Task | null> {
    const task = this.tasks.get(id);
    return task ? clone(task) : null;
  }

  async list(filter: TaskListFilter = {}): Promise<Task[]> {
    const result: Task[] = [];
    for (const task of this.tasks.values()) {
      if (!filter.includeDeleted && task.deletedAt !== null) continue;
      if (filter.status !== undefined && task.status !== filter.status) continue;
      result.push(clone(task));
    }
    return result;
  }

  async save(task: Task): Promise<void> {
    if (!this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} does not exist`);
    }
    this.tasks.set(task.id, clone(task));
  }
}
