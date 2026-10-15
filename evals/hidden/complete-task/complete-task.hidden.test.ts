import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: complete-task", () => {
  it("completes a todo task, bumps updatedAt and returns the task", async () => {
    const api = setup();
    const task = await api.create({ title: "Ship", description: "v1" });
    api.clock.advance(60_000);

    const res = await api.post(`/tasks/${task.id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: task.id,
      title: "Ship",
      description: "v1",
      status: "done",
      createdAt: task.createdAt,
      updatedAt: api.clock.iso(),
      deletedAt: null,
    });
    const after = await api.get(`/tasks/${task.id}`);
    expect(after.body.status).toBe("done");
    expect(after.body.updatedAt).toBe(api.clock.iso());
  });

  it("completes an in_progress task", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "in_progress" });
    const res = await api.post(`/tasks/${task.id}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("returns 409 CONFLICT for a deleted task and does not change it", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const res = await api.post(`/tasks/${task.id}/complete`);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("CONFLICT");
  });

  it("returns 404 NOT_FOUND for an unknown task", async () => {
    const api = setup();
    const res = await api.post(`/tasks/does-not-exist/complete`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });
});
