import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

// The app clock starts at 2026-03-10T12:00:00Z (see harness). The real system date
// is irrelevant: "today" must come from the injected clock.

async function titles(api: ReturnType<typeof setup>, query: string): Promise<string[]> {
  const res = await api.get(`/tasks${query}`);
  expect(res.status).toBe(200);
  return res.body.items.map((t: { title: string }) => t.title);
}

describe("hidden: due-date", () => {
  it("defaults dueDate to null and exposes it on every task", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    expect(task.dueDate).toBeNull();
    expect((await api.get(`/tasks/${task.id}`)).body.dueDate).toBeNull();
    expect((await api.get(`/tasks`)).body.items[0].dueDate).toBeNull();
  });

  it("sets dueDate on create, changes it and clears it via PATCH", async () => {
    const api = setup();
    const task = await api.create({ title: "A", dueDate: "2026-04-01" });
    expect(task.dueDate).toBe("2026-04-01");

    const changed = await api.patch(`/tasks/${task.id}`, { dueDate: "2026-05-02" });
    expect(changed.status).toBe(200);
    expect(changed.body.dueDate).toBe("2026-05-02");

    const cleared = await api.patch(`/tasks/${task.id}`, { dueDate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.dueDate).toBeNull();
  });

  it("does not touch dueDate when PATCH omits it", async () => {
    const api = setup();
    const task = await api.create({ title: "A", dueDate: "2026-04-01" });
    const res = await api.patch(`/tasks/${task.id}`, { status: "in_progress" });
    expect(res.body.dueDate).toBe("2026-04-01");
  });

  it.each(["2026-02-30", "2026-13-01", "2026-4-1", "01.04.2026", "2026-04-01T00:00:00Z", "", 20260401])(
    "rejects dueDate %j with 400 VALIDATION_ERROR",
    async (dueDate) => {
      const api = setup();
      const res = await api.post(`/tasks`, { title: "A", dueDate });
      expect(res.status).toBe(400);
      expect(errorCode(res)).toBe("VALIDATION_ERROR");
      const task = await api.create({ title: "B" });
      const patch = await api.patch(`/tasks/${task.id}`, { dueDate });
      expect(patch.status).toBe(400);
      expect(errorCode(patch)).toBe("VALIDATION_ERROR");
    },
  );

  it("accepts Feb 29 in a leap year", async () => {
    const api = setup();
    const res = await api.post(`/tasks`, { title: "A", dueDate: "2028-02-29" });
    expect(res.status).toBe(201);
  });

  it("overdue=true returns only tasks due before today (by app clock) that are not done", async () => {
    const api = setup();
    await api.create({ title: "yesterday", dueDate: "2026-03-09" });
    await api.create({ title: "long ago", dueDate: "2025-12-31", status: "in_progress" });
    await api.create({ title: "today", dueDate: "2026-03-10" });
    await api.create({ title: "tomorrow", dueDate: "2026-03-11" });
    await api.create({ title: "done late", dueDate: "2026-03-01", status: "done" });
    await api.create({ title: "no due date" });

    expect(await titles(api, "?overdue=true")).toEqual(["yesterday", "long ago"]);
  });

  it("follows the app clock as time passes", async () => {
    const api = setup();
    await api.create({ title: "today", dueDate: "2026-03-10" });
    expect(await titles(api, "?overdue=true")).toEqual([]);
    api.clock.advance(12 * 60 * 60 * 1000); // 2026-03-11T00:00:00Z
    expect(await titles(api, "?overdue=true")).toEqual(["today"]);
  });

  it("uses the UTC date of the clock", async () => {
    const api = setup("2026-03-10T23:30:00.000Z");
    await api.create({ title: "due 10th", dueDate: "2026-03-10" });
    await api.create({ title: "due 9th", dueDate: "2026-03-09" });
    expect(await titles(api, "?overdue=true")).toEqual(["due 9th"]);
  });

  it("combines overdue with status", async () => {
    const api = setup();
    await api.create({ title: "a", dueDate: "2026-03-01", status: "todo" });
    await api.create({ title: "b", dueDate: "2026-03-01", status: "in_progress" });
    expect(await titles(api, "?overdue=true&status=in_progress")).toEqual(["b"]);
  });

  it("excludes deleted tasks from overdue", async () => {
    const api = setup();
    const a = await api.create({ title: "a", dueDate: "2026-03-01" });
    await api.remove(a.id);
    expect(await titles(api, "?overdue=true")).toEqual([]);
  });

  it.each(["false", "1", "yes", ""])("rejects overdue=%s with 400 VALIDATION_ERROR", async (v) => {
    const api = setup();
    const res = await api.get(`/tasks?overdue=${v}`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});
