import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: reopen-task", () => {
  it("moves a done task back to todo and bumps updatedAt", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "done" });
    api.clock.advance(30_000);

    const res = await api.post(`/tasks/${task.id}/reopen`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: task.id,
      title: "A",
      status: "todo",
      createdAt: task.createdAt,
      updatedAt: api.clock.iso(),
      deletedAt: null,
    });
    expect((await api.get(`/tasks/${task.id}`)).body.status).toBe("todo");
  });

  it.each(["todo", "in_progress"])(
    "returns 409 CONFLICT for a %s task and leaves it unchanged",
    async (status) => {
      const api = setup();
      const task = await api.create({ title: "A", status });
      api.clock.advance(30_000);
      const res = await api.post(`/tasks/${task.id}/reopen`);
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("CONFLICT");
      const after = await api.get(`/tasks/${task.id}`);
      expect(after.body.status).toBe(status);
      expect(after.body.updatedAt).toBe(task.updatedAt);
    },
  );

  it("returns 409 CONFLICT for a deleted task", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "done" });
    await api.remove(task.id);
    const res = await api.post(`/tasks/${task.id}/reopen`);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("CONFLICT");
  });

  it("returns 404 NOT_FOUND for an unknown task", async () => {
    const api = setup();
    const res = await api.post(`/tasks/nope/reopen`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });
});
