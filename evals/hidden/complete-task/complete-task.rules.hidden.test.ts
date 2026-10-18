// TaskFlow repository rules (fixtures/taskflow/CLAUDE.md) applied to the new route.
// Every test here must fail on factory-baseline; `[guard]` tests must pass there.
import { describe, expect, it } from "vitest";
import { setup, type Res } from "./_harness.js";

const TASK_KEYS = ["createdAt", "deletedAt", "description", "id", "status", "title", "updatedAt"];

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.objectContaining({ code, message: expect.any(String) }) });
  expect(Object.keys(res.body.error).every((k) => ["code", "message", "details"].includes(k))).toBe(true);
}

describe("hidden rules: complete-task", () => {
  it("rejects an unknown body key with 400 VALIDATION_ERROR and leaves the task unchanged", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(1000);
    const res = await api.post(`/tasks/${task.id}/complete`, { unexpected: true });
    expectError(res, 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${task.id}`)).body).toEqual(task);
  });

  it("accepts an empty JSON object body", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const res = await api.post(`/tasks/${task.id}/complete`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("[guard] rejects malformed JSON with 400 VALIDATION_ERROR", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const raw = await api.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/complete`,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expectError({ status: raw.statusCode, body: JSON.parse(raw.body) }, 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${task.id}`)).body.status).toBe("todo");
  });

  it("returns exactly the task fields", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const res = await api.post(`/tasks/${task.id}/complete`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(TASK_KEYS);
  });

  it("answers 409 for a deleted task in the standard error shape; the task stays deleted", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    expectError(await api.post(`/tasks/${task.id}/complete`), 409, "CONFLICT");
    expectError(await api.get(`/tasks/${task.id}`), 404, "NOT_FOUND");
    expect((await api.get(`/tasks`)).body.items).toEqual([]);
  });
});
