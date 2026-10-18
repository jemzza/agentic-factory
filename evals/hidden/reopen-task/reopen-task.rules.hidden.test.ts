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

describe("hidden rules: reopen-task", () => {
  it("rejects an unknown body key with 400 VALIDATION_ERROR and leaves the task unchanged", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "done" });
    api.clock.advance(1000);
    const res = await api.post(`/tasks/${task.id}/reopen`, { unexpected: true });
    expectError(res, 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${task.id}`)).body).toEqual(task);
  });

  it("accepts an empty JSON object body", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "done" });
    const res = await api.post(`/tasks/${task.id}/reopen`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("todo");
  });

  it("[guard] rejects malformed JSON with 400 VALIDATION_ERROR", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "done" });
    const raw = await api.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/reopen`,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expectError({ status: raw.statusCode, body: JSON.parse(raw.body) }, 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${task.id}`)).body.status).toBe("done");
  });

  it("returns exactly the task fields", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "done" });
    const res = await api.post(`/tasks/${task.id}/reopen`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(TASK_KEYS);
  });

  it("answers 409 in the standard error shape for a task that is not done and for a deleted one", async () => {
    const api = setup();
    const open = await api.create({ title: "Open" });
    const gone = await api.create({ title: "Gone", status: "done" });
    await api.remove(gone.id);
    expectError(await api.post(`/tasks/${open.id}/reopen`), 409, "CONFLICT");
    expectError(await api.post(`/tasks/${gone.id}/reopen`), 409, "CONFLICT");
    expectError(await api.get(`/tasks/${gone.id}`), 404, "NOT_FOUND");
  });
});
