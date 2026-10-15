import { describe, expect, it } from "vitest";
import { createTask, deleteTask, setup } from "./helpers.js";

describe("POST /tasks", () => {
  it("creates a task with defaults", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "Write docs" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: "task-1",
      title: "Write docs",
      description: "",
      status: "todo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
  });

  it("accepts description and status", async () => {
    const { app } = setup();
    const task = await createTask(app, {
      title: "Ship it",
      description: "Release v1",
      status: "in_progress",
    });
    expect(task).toMatchObject({ description: "Release v1", status: "in_progress" });
  });

  it("trims the title", async () => {
    const { app } = setup();
    const task = await createTask(app, { title: "  Padded  " });
    expect(task.title).toBe("Padded");
  });

  it.each([
    ["missing title", {}],
    ["empty title", { title: "" }],
    ["whitespace-only title", { title: "   " }],
    ["too long title", { title: "x".repeat(201) }],
    ["non-string title", { title: 42 }],
    ["unknown status", { title: "A", status: "archived" }],
    ["too long description", { title: "A", description: "x".repeat(2001) }],
    ["unknown field", { title: "A", priority: "high" }],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_name, payload) => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/tasks", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("rejects malformed JSON with 400 VALIDATION_ERROR", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("rejects a duplicate title (case-insensitive) with 409 CONFLICT", async () => {
    const { app } = setup();
    await createTask(app, { title: "Write docs" });
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "WRITE DOCS" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("allows reusing the title of a deleted task", async () => {
    const { app } = setup();
    const first = await createTask(app, { title: "Write docs" });
    await deleteTask(app, first.id);
    const second = await createTask(app, { title: "Write docs" });
    expect(second.id).not.toBe(first.id);
  });
});
