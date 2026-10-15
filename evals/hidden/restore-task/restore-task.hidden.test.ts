import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: restore-task", () => {
  it("restores a deleted task: deletedAt null, updatedAt bumped, 200 with the task", async () => {
    const api = setup();
    const task = await api.create({ title: "A", description: "d", status: "in_progress" });
    api.clock.advance(1000);
    await api.remove(task.id);
    api.clock.advance(1000);

    const res = await api.post(`/tasks/${task.id}/restore`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: task.id,
      title: "A",
      description: "d",
      status: "in_progress",
      createdAt: task.createdAt,
      updatedAt: api.clock.iso(),
      deletedAt: null,
    });
  });

  it("makes the task visible again in GET and in the list", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    await api.post(`/tasks/${task.id}/restore`);

    const one = await api.get(`/tasks/${task.id}`);
    expect(one.status).toBe(200);
    const list = await api.get(`/tasks`);
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([task.id]);
  });

  it("restored tasks can be modified and deleted again", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    await api.post(`/tasks/${task.id}/restore`);
    const patched = await api.patch(`/tasks/${task.id}`, { status: "done" });
    expect(patched.status).toBe(200);
    expect((await api.del(`/tasks/${task.id}`)).status).toBe(204);
  });

  it("returns 409 CONFLICT for a task that is not deleted", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const res = await api.post(`/tasks/${task.id}/restore`);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("CONFLICT");
  });

  it("returns 404 NOT_FOUND for an unknown task", async () => {
    const api = setup();
    const res = await api.post(`/tasks/nope/restore`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT when an active task already has the same title (case-insensitive)", async () => {
    const api = setup();
    const old = await api.create({ title: "Write docs" });
    await api.remove(old.id);
    await api.create({ title: "WRITE DOCS" });

    const res = await api.post(`/tasks/${old.id}/restore`);

    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("CONFLICT");
    expect((await api.get(`/tasks/${old.id}`)).status).toBe(404);
    expect((await api.get(`/tasks`)).body.items).toHaveLength(1);
  });
});
