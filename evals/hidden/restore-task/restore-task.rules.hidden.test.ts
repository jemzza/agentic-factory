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

describe("hidden rules: restore-task", () => {
  it("rejects an unknown body key with 400 VALIDATION_ERROR; the task stays deleted", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const res = await api.post(`/tasks/${task.id}/restore`, { unexpected: true });
    expectError(res, 400, "VALIDATION_ERROR");
    expectError(await api.get(`/tasks/${task.id}`), 404, "NOT_FOUND");
  });

  it("accepts an empty JSON object body", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const res = await api.post(`/tasks/${task.id}/restore`, {});
    expect(res.status).toBe(200);
    expect(res.body.deletedAt).toBeNull();
  });

  it("[guard] rejects malformed JSON with 400 VALIDATION_ERROR; the task stays deleted", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const raw = await api.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/restore`,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expectError({ status: raw.statusCode, body: JSON.parse(raw.body) }, 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${task.id}`)).status).toBe(404);
  });

  it("returns exactly the task fields", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const res = await api.post(`/tasks/${task.id}/restore`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(TASK_KEYS);
  });

  it("a restored task takes part in title uniqueness again", async () => {
    const api = setup();
    const task = await api.create({ title: "Write docs" });
    await api.remove(task.id);
    expect((await api.post(`/tasks/${task.id}/restore`)).status).toBe(200);
    expectError(await api.post(`/tasks`, { title: "write DOCS" }), 409, "CONFLICT");
  });

  it("answers 409 in the standard error shape for a task that is not deleted", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(1000);
    expectError(await api.post(`/tasks/${task.id}/restore`), 409, "CONFLICT");
    expect((await api.get(`/tasks/${task.id}`)).body).toEqual(task);
  });
});
