// TaskFlow repository rules (fixtures/taskflow/CLAUDE.md) applied to search.
// Every test here must fail on factory-baseline; `[guard]` tests must pass there.
import { describe, expect, it } from "vitest";
import { setup, type Res } from "./_harness.js";

const TASK_KEYS = ["createdAt", "deletedAt", "description", "id", "status", "title", "updatedAt"];

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.objectContaining({ code, message: expect.any(String) }) });
  expect(Object.keys(res.body.error).every((k) => ["code", "message", "details"].includes(k))).toBe(true);
}

describe("hidden rules: search-tasks", () => {
  it("uses the standard error shape for an empty and a too long q", async () => {
    const api = setup();
    await api.create({ title: "A" });
    expectError(await api.get(`/tasks?q=%20%20`), 400, "VALIDATION_ERROR");
    expectError(await api.get(`/tasks?q=${"x".repeat(101)}`), 400, "VALIDATION_ERROR");
  });

  it("returns matches in creation order, as { items } with exactly the task fields", async () => {
    const api = setup();
    await api.create({ title: "zebra apple" });
    await api.create({ title: "pear" });
    await api.create({ title: "Apple pie" });
    const res = await api.get(`/tasks?q=apple`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["items"]);
    expect(res.body.items.map((t: { title: string }) => t.title)).toEqual(["zebra apple", "Apple pie"]);
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(TASK_KEYS);
  });

  it("[guard] an invalid status filter is still 400 VALIDATION_ERROR", async () => {
    const api = setup();
    expectError(await api.get(`/tasks?status=archived&q=a`), 400, "VALIDATION_ERROR");
  });

  it("[guard] the status filter alone works as before", async () => {
    const api = setup();
    await api.create({ title: "A" });
    await api.create({ title: "B", status: "done" });
    const res = await api.get(`/tasks?status=done`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { title: string }) => t.title)).toEqual(["B"]);
  });
});
