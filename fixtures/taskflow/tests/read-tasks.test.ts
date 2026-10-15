import { describe, expect, it } from "vitest";
import type { TaskDto } from "../src/domain/task.js";
import { createTask, deleteTask, setup } from "./helpers.js";

describe("GET /tasks/:id", () => {
  it("returns an existing task", async () => {
    const { app } = setup();
    const created = await createTask(app);
    const res = await app.inject({ method: "GET", url: `/tasks/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it("returns 404 NOT_FOUND for an unknown id", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/tasks/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Task nope not found" },
    });
  });

  it("returns 404 NOT_FOUND for a soft-deleted task", async () => {
    const { app } = setup();
    const created = await createTask(app);
    await deleteTask(app, created.id);
    const res = await app.inject({ method: "GET", url: `/tasks/${created.id}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("GET /tasks", () => {
  async function listTitles(
    app: ReturnType<typeof setup>["app"],
    query = "",
  ): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: `/tasks${query}` });
    expect(res.statusCode).toBe(200);
    return res.json<{ items: TaskDto[] }>().items.map((t) => t.title);
  }

  it("returns an empty list initially", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it("lists tasks in creation order", async () => {
    const { app, clock } = setup();
    await createTask(app, { title: "A" });
    clock.advance(1000);
    await createTask(app, { title: "B" });
    clock.advance(1000);
    await createTask(app, { title: "C" });
    expect(await listTitles(app)).toEqual(["A", "B", "C"]);
  });

  it("filters by status", async () => {
    const { app } = setup();
    await createTask(app, { title: "A", status: "todo" });
    await createTask(app, { title: "B", status: "done" });
    await createTask(app, { title: "C", status: "done" });
    expect(await listTitles(app, "?status=done")).toEqual(["B", "C"]);
    expect(await listTitles(app, "?status=in_progress")).toEqual([]);
  });

  it("excludes soft-deleted tasks, with and without a filter", async () => {
    const { app } = setup();
    const a = await createTask(app, { title: "A", status: "done" });
    await createTask(app, { title: "B", status: "done" });
    await deleteTask(app, a.id);
    expect(await listTitles(app)).toEqual(["B"]);
    expect(await listTitles(app, "?status=done")).toEqual(["B"]);
  });

  it("rejects an unknown status filter with 400 VALIDATION_ERROR", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/tasks?status=archived" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });
});

describe("unknown routes", () => {
  it("return 404 NOT_FOUND in the standard error format", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
