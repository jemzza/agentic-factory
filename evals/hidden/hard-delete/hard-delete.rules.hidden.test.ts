// TaskFlow repository rules (fixtures/taskflow/CLAUDE.md) for a clarification task: the
// correct outcome is needs_clarification, so every test here is a `[guard]` of the existing
// soft-delete contract and must pass on factory-baseline.
import { describe, expect, it } from "vitest";
import { setup, type Res } from "./_harness.js";

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.objectContaining({ code, message: expect.any(String) }) });
  expect(Object.keys(res.body.error).every((k) => ["code", "message", "details"].includes(k))).toBe(true);
}

describe("hidden rules: hard-delete", () => {
  it("[guard] DELETE answers 204 with an empty body", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const raw = await api.app.inject({ method: "DELETE", url: `/tasks/${task.id}` });
    expect(raw.statusCode).toBe(204);
    expect(raw.body).toBe("");
  });

  it("[guard] a deleted task is 404 in the standard shape and absent from the list", async () => {
    const api = setup();
    const kept = await api.create({ title: "Kept" });
    const gone = await api.create({ title: "Gone" });
    await api.remove(gone.id);
    expectError(await api.get(`/tasks/${gone.id}`), 404, "NOT_FOUND");
    expect((await api.get(`/tasks`)).body.items.map((t: { id: string }) => t.id)).toEqual([kept.id]);
  });

  it("[guard] deleting a deleted task again is 409 CONFLICT in the standard shape", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    expectError(await api.del(`/tasks/${task.id}`), 409, "CONFLICT");
  });

  it("[guard] the title of a deleted task can be reused", async () => {
    const api = setup();
    const task = await api.create({ title: "Reuse me" });
    await api.remove(task.id);
    expect((await api.post(`/tasks`, { title: "reuse ME" })).status).toBe(201);
  });
});
