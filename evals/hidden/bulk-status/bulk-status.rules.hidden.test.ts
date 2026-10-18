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

describe("hidden rules: bulk-status", () => {
  it("rejects an unknown body key with 400 VALIDATION_ERROR and changes nothing", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    api.clock.advance(1000);
    const res = await api.post(`/tasks/bulk-status`, { ids: [a.id], status: "done", extra: 1 });
    expectError(res, 400, "VALIDATION_ERROR");
    expect((await api.get(`/tasks/${a.id}`)).body).toEqual(a);
  });

  it("[guard] rejects malformed JSON with 400 VALIDATION_ERROR", async () => {
    const api = setup();
    const raw = await api.app.inject({
      method: "POST",
      url: `/tasks/bulk-status`,
      headers: { "content-type": "application/json" },
      payload: '{"ids": [',
    });
    expectError({ status: raw.statusCode, body: JSON.parse(raw.body) }, 400, "VALIDATION_ERROR");
  });

  it("returns exactly { items } with exactly the task fields per item", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const b = await api.create({ title: "B" });
    const res = await api.post(`/tasks/bulk-status`, { ids: [a.id, b.id], status: "in_progress" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["items"]);
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(TASK_KEYS);
  });

  it("uses the standard error shape for 400, 404 and 409", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const b = await api.create({ title: "B" });
    await api.remove(b.id);
    expectError(await api.post(`/tasks/bulk-status`, { ids: [], status: "done" }), 400, "VALIDATION_ERROR");
    expectError(await api.post(`/tasks/bulk-status`, { ids: [a.id, "nope"], status: "done" }), 404, "NOT_FOUND");
    expectError(await api.post(`/tasks/bulk-status`, { ids: [a.id, b.id], status: "done" }), 409, "CONFLICT");
    expect((await api.get(`/tasks/${a.id}`)).body.status).toBe("todo");
  });

  it("a deleted task stays deleted and hidden after a failed bulk request", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const b = await api.create({ title: "B" });
    await api.remove(b.id);
    expect((await api.post(`/tasks/bulk-status`, { ids: [b.id], status: "done" })).status).toBe(409);
    expect((await api.get(`/tasks`)).body.items.map((t: { id: string }) => t.id)).toEqual([a.id]);
  });
});
