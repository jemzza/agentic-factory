import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: status-history", () => {
  it("records the initial status at creation", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "in_progress" });
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ from: null, to: "in_progress", at: task.createdAt }] });
  });

  it("defaults the initial entry to todo", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.body.items).toEqual([{ from: null, to: "todo", at: task.createdAt }]);
  });

  it("appends an entry for each status change, in chronological order", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(1000);
    const p1 = await api.patch(`/tasks/${task.id}`, { status: "in_progress" });
    api.clock.advance(1000);
    const p2 = await api.patch(`/tasks/${task.id}`, { status: "done", title: "A2" });
    api.clock.advance(1000);
    const p3 = await api.patch(`/tasks/${task.id}`, { status: "todo" });

    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.body.items).toEqual([
      { from: null, to: "todo", at: task.createdAt },
      { from: "todo", to: "in_progress", at: p1.body.updatedAt },
      { from: "in_progress", to: "done", at: p2.body.updatedAt },
      { from: "done", to: "todo", at: p3.body.updatedAt },
    ]);
  });

  it("does not record PATCHes that leave the status unchanged", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(1000);
    await api.patch(`/tasks/${task.id}`, { title: "B" });
    await api.patch(`/tasks/${task.id}`, { status: "todo" });
    await api.patch(`/tasks/${task.id}`, { description: "x", status: "todo" });
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.body.items).toHaveLength(1);
  });

  it("does not record failed status changes", async () => {
    const api = setup();
    await api.create({ title: "Taken" });
    const task = await api.create({ title: "A" });
    const bad = await api.patch(`/tasks/${task.id}`, { status: "done", title: "taken" });
    expect(bad.status).toBe(409);
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.body.items).toHaveLength(1);
  });

  it("keeps histories separate per task", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const b = await api.create({ title: "B" });
    await api.patch(`/tasks/${a.id}`, { status: "done" });
    expect((await api.get(`/tasks/${a.id}/history`)).body.items).toHaveLength(2);
    expect((await api.get(`/tasks/${b.id}/history`)).body.items).toHaveLength(1);
  });

  it("returns 404 NOT_FOUND for a deleted task", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND for an unknown task", async () => {
    const api = setup();
    const res = await api.get(`/tasks/nope/history`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });

  it("does not change the task format elsewhere", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.patch(`/tasks/${task.id}`, { status: "done" });
    const keys = ["createdAt", "deletedAt", "description", "id", "status", "title", "updatedAt"];
    expect(Object.keys(task).sort()).toEqual(keys);
    expect(Object.keys((await api.get(`/tasks/${task.id}`)).body).sort()).toEqual(keys);
    expect(Object.keys((await api.get(`/tasks`)).body.items[0]).sort()).toEqual(keys);
    expect(Object.keys((await api.patch(`/tasks/${task.id}`, { title: "B" })).body).sort()).toEqual(keys);
  });
});
