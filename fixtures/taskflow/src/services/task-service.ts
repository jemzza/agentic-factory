import { isDeleted, type Task, type TaskStatus } from "../domain/task.js";
import { conflict, notFound } from "../errors.js";
import type { TaskRepository } from "../repository/task-repository.js";

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
}

export interface TaskServiceDeps {
  repository: TaskRepository;
  clock: () => Date;
  generateId: () => string;
}

/**
 * Business rules for tasks.
 *
 * - Reads (`get`, `list`) treat soft-deleted tasks as absent → NOT_FOUND.
 * - Mutations of a soft-deleted task → CONFLICT; of an unknown id → NOT_FOUND.
 * - Titles are unique among active (non-deleted) tasks, compared case-insensitively.
 */
export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async create(input: CreateTaskInput): Promise<Task> {
    await this.assertTitleAvailable(input.title);
    const now = this.deps.clock();
    const task: Task = {
      id: this.deps.generateId(),
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "todo",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.deps.repository.insert(task);
    return task;
  }

  async get(id: string): Promise<Task> {
    const task = await this.deps.repository.findById(id);
    if (!task || isDeleted(task)) throw notFound(`Task ${id} not found`);
    return task;
  }

  async list(filter: { status?: TaskStatus } = {}): Promise<Task[]> {
    return this.deps.repository.list(filter.status ? { status: filter.status } : {});
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const task = await this.getMutable(id);
    if (input.title !== undefined) await this.assertTitleAvailable(input.title, id);
    const updated: Task = {
      ...task,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      updatedAt: this.deps.clock(),
    };
    await this.deps.repository.save(updated);
    return updated;
  }

  async softDelete(id: string): Promise<void> {
    const task = await this.getMutable(id);
    const now = this.deps.clock();
    await this.deps.repository.save({ ...task, deletedAt: now, updatedAt: now });
  }

  /** Loads a task that may be modified: exists and is not soft-deleted. */
  private async getMutable(id: string): Promise<Task> {
    const task = await this.deps.repository.findById(id);
    if (!task) throw notFound(`Task ${id} not found`);
    if (isDeleted(task)) throw conflict(`Task ${id} is deleted`);
    return task;
  }

  private async assertTitleAvailable(title: string, exceptId?: string): Promise<void> {
    const normalized = title.toLowerCase();
    const active = await this.deps.repository.list();
    const clash = active.find((t) => t.id !== exceptId && t.title.toLowerCase() === normalized);
    if (clash) throw conflict(`A task titled "${title}" already exists`);
  }
}
