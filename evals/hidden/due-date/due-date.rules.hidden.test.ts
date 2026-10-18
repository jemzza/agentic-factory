// TaskFlow repository rules (fixtures/taskflow/CLAUDE.md) applied to the new field.
// Every test here must fail on factory-baseline; `[guard]` tests must pass there.
import { describe, expect, it } from "vitest";
import { setup, type Res } from "./_harness.js";

const TASK_KEYS = ["createdAt", "deletedAt", "description", "dueDate", "id", "status", "title", "updatedAt"];

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.objectContaining({ code, message: expect.any(String) }) });
  expect(Object.keys(res.body.error).every((k) => ["code", "message", "details"].includes(k))).toBe(true);
}

describe("hidden rules: due-date", () => {
  it("[guard] bodies stay strict: an unknown key next to dueDate is 400 VALIDATION_ERROR", async () => {
    const api = setup();
    expectError(await api.post(`/tasks`, { title: "A", dueDate: "2026-04-01", extra: 1 }), 400, "VALIDATION_ERROR");
    const task = await api.create({ title: "B" });
    expectError(await api.patch(`/tasks/${task.id}`, { dueDate: null, extra: 1 }), 400, "VALIDATION_ERROR");
  });

  it("changing dueDate of a deleted task is 409 CONFLICT", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    expectError(await api.patch(`/tasks/${task.id}`, { dueDate: "2026-04-01" }), 409, "CONFLICT");
  });

  it("a PATCH of dueDate alone bumps updatedAt", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(60_000);
    const res = await api.patch(`/tasks/${task.id}`, { dueDate: "2026-04-01" });
    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(api.clock.iso());
    expect(res.body.createdAt).toBe(task.createdAt);
  });

  it("an invalid dueDate changes nothing", async () => {
    const api = setup();
    const task = await api.create({ title: "A", dueDate: "2026-04-01" });
    api.clock.advance(60_000);
    expectError(await api.patch(`/tasks/${task.id}`, { title: "B", dueDate: "2026-02-30" }), 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${task.id}`)).body).toEqual(task);
  });

  it("every response carries exactly the task fields plus dueDate", async () => {
    const api = setup();
    const task = await api.create({ title: "A", dueDate: "2026-03-01" });
    expect(Object.keys(task).sort()).toEqual(TASK_KEYS);
    expect(Object.keys((await api.get(`/tasks/${task.id}`)).body).sort()).toEqual(TASK_KEYS);
    const overdue = await api.get(`/tasks?overdue=true`);
    expect(overdue.status).toBe(200);
    expect(overdue.body.items).toHaveLength(1);
    expect(Object.keys(overdue.body.items[0]).sort()).toEqual(TASK_KEYS);
  });

  it("uses the standard error shape for an invalid overdue value", async () => {
    const api = setup();
    expectError(await api.get(`/tasks?overdue=yes`), 400, "VALIDATION_ERROR");
  });

  it("overdue results keep creation order", async () => {
    const api = setup();
    await api.create({ title: "late", dueDate: "2026-03-05" });
    await api.create({ title: "not due", dueDate: "2026-12-31" });
    await api.create({ title: "earlier", dueDate: "2026-01-01" });
    const res = await api.get(`/tasks?overdue=true`);
    expect(res.body.items.map((t: { title: string }) => t.title)).toEqual(["late", "earlier"]);
  });
});
