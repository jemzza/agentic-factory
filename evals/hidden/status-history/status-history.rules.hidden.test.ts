// TaskFlow repository rules (fixtures/taskflow/CLAUDE.md) applied to the history.
// Every test here must fail on factory-baseline; `[guard]` tests must pass there.
import { describe, expect, it } from "vitest";
import { setup } from "./_harness.js";

describe("hidden rules: status-history", () => {
  it("a PATCH rejected for an unknown body key records nothing", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const bad = await api.patch(`/tasks/${task.id}`, { status: "done", extra: 1 });
    expect(bad.status).toBe(400);
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ from: null, to: "todo", at: task.createdAt }]);
  });

  it("a PATCH of a deleted task is 409 and does not touch the history of other tasks", async () => {
    const api = setup();
    const kept = await api.create({ title: "Kept" });
    const gone = await api.create({ title: "Gone" });
    await api.remove(gone.id);
    expect((await api.patch(`/tasks/${gone.id}`, { status: "done" })).status).toBe(409);
    const res = await api.get(`/tasks/${kept.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("returns exactly { items } with exactly { from, to, at } per entry", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(1000);
    await api.patch(`/tasks/${task.id}`, { status: "done" });
    const res = await api.get(`/tasks/${task.id}/history`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["items"]);
    expect(res.body.items).toHaveLength(2);
    for (const entry of res.body.items) expect(Object.keys(entry).sort()).toEqual(["at", "from", "to"]);
  });

  it("a title-only PATCH bumps updatedAt but records no status change", async () => {
    const api = setup();
    const task = await api.create({ title: "A", status: "in_progress" });
    api.clock.advance(1000);
    const res = await api.patch(`/tasks/${task.id}`, { title: "B" });
    expect(res.body.updatedAt).toBe(api.clock.iso());
    const history = await api.get(`/tasks/${task.id}/history`);
    expect(history.body.items).toEqual([{ from: null, to: "in_progress", at: task.createdAt }]);
  });
});
