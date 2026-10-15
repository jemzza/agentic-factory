import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: bulk-status", () => {
  it("updates all tasks and returns them in ids order with bumped updatedAt", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const b = await api.create({ title: "B", status: "in_progress" });
    const c = await api.create({ title: "C" });
    api.clock.advance(5000);

    const res = await api.post(`/tasks/bulk-status`, { ids: [c.id, a.id], status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([c.id, a.id]);
    for (const t of res.body.items) {
      expect(t.status).toBe("done");
      expect(t.updatedAt).toBe(api.clock.iso());
    }
    const untouched = await api.get(`/tasks/${b.id}`);
    expect(untouched.body.status).toBe("in_progress");
    expect(untouched.body.updatedAt).toBe(b.updatedAt);
    expect((await api.get(`/tasks/${a.id}`)).body.status).toBe("done");
  });

  it("accepts exactly 100 ids", async () => {
    const api = setup();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push((await api.create({ title: `t${i}` })).id);
    const res = await api.post(`/tasks/bulk-status`, { ids, status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(100);
  });

  it.each([
    ["empty ids", { ids: [], status: "done" }],
    ["missing ids", { status: "done" }],
    ["missing status", { ids: ["id-1"] }],
    ["unknown status", { ids: ["id-1"], status: "archived" }],
    ["duplicate ids", { ids: ["id-1", "id-1"], status: "done" }],
    ["non-string id", { ids: [1], status: "done" }],
    ["too many ids", { ids: Array.from({ length: 101 }, (_, i) => `id-${i + 1}`), status: "done" }],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_name, payload) => {
    const api = setup();
    await api.create({ title: "A" });
    const res = await api.post(`/tasks/bulk-status`, payload);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
    expect((await api.get(`/tasks/id-1`)).body.status).toBe("todo");
  });

  it("returns 404 NOT_FOUND and changes nothing when an id is unknown (even if listed last)", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const b = await api.create({ title: "B" });
    api.clock.advance(5000);
    const res = await api.post(`/tasks/bulk-status`, { ids: [a.id, b.id, "nope"], status: "done" });
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
    for (const t of [a, b]) {
      const after = await api.get(`/tasks/${t.id}`);
      expect(after.body.status).toBe("todo");
      expect(after.body.updatedAt).toBe(t.updatedAt);
    }
  });

  it("returns 409 CONFLICT and changes nothing when a task is deleted", async () => {
    const api = setup();
    const a = await api.create({ title: "A" });
    const d = await api.create({ title: "D" });
    await api.remove(d.id);
    api.clock.advance(5000);
    const res = await api.post(`/tasks/bulk-status`, { ids: [a.id, d.id], status: "done" });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("CONFLICT");
    const after = await api.get(`/tasks/${a.id}`);
    expect(after.body.status).toBe("todo");
    expect(after.body.updatedAt).toBe(a.updatedAt);
  });
});
