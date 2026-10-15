// The request contradicts itself (no trace in storage vs. telling deleted from unknown)
// and the error contract. The correct system outcome is needs_clarification; these tests
// guard that existing soft-delete behavior is preserved if anything gets implemented.
import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: hard-delete (existing soft-delete contract preserved)", () => {
  it("DELETE soft-deletes: 204, then GET is 404 NOT_FOUND", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    const del = await api.del(`/tasks/${task.id}`);
    expect(del.status).toBe(204);
    const res = await api.get(`/tasks/${task.id}`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });

  it("mutating a deleted task is 409 CONFLICT", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    const res = await api.patch(`/tasks/${task.id}`, { title: "B" });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("CONFLICT");
    const again = await api.del(`/tasks/${task.id}`);
    expect(again.status).toBe(409);
  });

  it("unknown ids are 404 NOT_FOUND", async () => {
    const api = setup();
    const res = await api.get(`/tasks/never-existed`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });
});
