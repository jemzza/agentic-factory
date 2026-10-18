import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: location-field", () => {
  it("defaults to null everywhere; set on create, change and clear via PATCH", async () => {
    const api = setup();
    const plain = await api.create({ title: "A" });
    expect(plain.location).toBeNull();
    expect((await api.get(`/tasks`)).body.items[0].location).toBeNull();
    const task = await api.create({ title: "B", location: "Office" });
    expect(task.location).toBe("Office");
    expect((await api.patch(`/tasks/${task.id}`, { location: "Home" })).body.location).toBe("Home");
    expect((await api.patch(`/tasks/${task.id}`, { location: null })).body.location).toBeNull();
  });

  it("rejects a non-string location with 400 VALIDATION_ERROR", async () => {
    const api = setup();
    expect(errorCode(await api.post(`/tasks`, { title: "A", location: 42 }))).toBe("VALIDATION_ERROR");
  });

  it("[lesson] trims, stores empty-after-trim as null, and allows at most 100 characters", async () => {
    const api = setup();
    expect((await api.create({ title: "A", location: "  Room 1  " })).location).toBe("Room 1");
    expect((await api.create({ title: "B", location: "   " })).location).toBeNull();
    expect((await api.create({ title: "C", location: "x".repeat(100) })).location).toHaveLength(100);
    expect(errorCode(await api.post(`/tasks`, { title: "D", location: "x".repeat(101) }))).toBe("VALIDATION_ERROR");
  });
});
