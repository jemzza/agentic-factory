import { describe, expect, it } from "vitest";
import type { Task } from "../src/domain/task.js";
import { InMemoryTaskRepository } from "../src/repository/in-memory-task-repository.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "t1",
    title: "A",
    description: "",
    status: "todo",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe("InMemoryTaskRepository", () => {
  it("returns copies so callers cannot mutate stored state", async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeTask());
    const loaded = await repo.findById("t1");
    loaded!.title = "mutated";
    loaded!.updatedAt.setFullYear(2000);
    expect(await repo.findById("t1")).toMatchObject({ title: "A" });
    expect((await repo.findById("t1"))!.updatedAt.getFullYear()).toBe(2026);
  });

  it("rejects inserting a duplicate id and saving an unknown id", async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeTask());
    await expect(repo.insert(makeTask())).rejects.toThrow();
    await expect(repo.save(makeTask({ id: "t2" }))).rejects.toThrow();
  });

  it("hides deleted tasks from list unless includeDeleted is set", async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeTask({ id: "t1" }));
    await repo.insert(makeTask({ id: "t2", deletedAt: new Date() }));
    expect((await repo.list()).map((t) => t.id)).toEqual(["t1"]);
    expect((await repo.list({ includeDeleted: true })).map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});
