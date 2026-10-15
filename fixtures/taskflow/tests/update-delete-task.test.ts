import { describe, expect, it } from "vitest";
import { createTask, deleteTask, setup } from "./helpers.js";

describe("PATCH /tasks/:id", () => {
  it("updates fields and bumps updatedAt", async () => {
    const { app, clock } = setup();
    const created = await createTask(app, { title: "Draft" });
    clock.advance(5000);

    const res = await app.inject({
      method: "PATCH",
      url: `/tasks/${created.id}`,
      payload: { title: "Final", status: "in_progress" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...created,
      title: "Final",
      status: "in_progress",
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
  });

  it("leaves omitted fields untouched", async () => {
    const { app } = setup();
    const created = await createTask(app, { title: "A", description: "keep me" });
    const res = await app.inject({
      method: "PATCH",
      url: `/tasks/${created.id}`,
      payload: { status: "done" },
    });
    expect(res.json()).toMatchObject({ title: "A", description: "keep me", status: "done" });
  });

  it("allows keeping the task's own title in a different case", async () => {
    const { app } = setup();
    const created = await createTask(app, { title: "Write docs" });
    const res = await app.inject({
      method: "PATCH",
      url: `/tasks/${created.id}`,
      payload: { title: "Write Docs" },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["empty body", {}],
    ["empty title", { title: "" }],
    ["unknown status", { status: "archived" }],
    ["unknown field", { deletedAt: null }],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_name, payload) => {
    const { app } = setup();
    const created = await createTask(app);
    const res = await app.inject({ method: "PATCH", url: `/tasks/${created.id}`, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("returns 404 NOT_FOUND for an unknown id", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "PATCH",
      url: "/tasks/nope",
      payload: { title: "X" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 409 CONFLICT for a soft-deleted task", async () => {
    const { app } = setup();
    const created = await createTask(app);
    await deleteTask(app, created.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/tasks/${created.id}`,
      payload: { title: "X" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("returns 409 CONFLICT when renaming to another active task's title", async () => {
    const { app } = setup();
    await createTask(app, { title: "A" });
    const b = await createTask(app, { title: "B" });
    const res = await app.inject({
      method: "PATCH",
      url: `/tasks/${b.id}`,
      payload: { title: "a" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });
});

describe("DELETE /tasks/:id", () => {
  it("soft-deletes the task and returns 204 with no body", async () => {
    const { app } = setup();
    const created = await createTask(app);
    const res = await app.inject({ method: "DELETE", url: `/tasks/${created.id}` });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const after = await app.inject({ method: "GET", url: `/tasks/${created.id}` });
    expect(after.statusCode).toBe(404);
  });

  it("returns 404 NOT_FOUND for an unknown id", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "DELETE", url: "/tasks/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 409 CONFLICT when the task is already deleted", async () => {
    const { app } = setup();
    const created = await createTask(app);
    await deleteTask(app, created.id);
    const res = await app.inject({ method: "DELETE", url: `/tasks/${created.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });
});
