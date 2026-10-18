// TaskFlow repository rules (fixtures/taskflow/CLAUDE.md) applied to the paginated list.
// Every test here must fail on factory-baseline; `[guard]` tests must pass there.
import { describe, expect, it } from "vitest";
import { setup, type Res } from "./_harness.js";

const TASK_KEYS = ["createdAt", "deletedAt", "description", "id", "status", "title", "updatedAt"];

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.objectContaining({ code, message: expect.any(String) }) });
  expect(Object.keys(res.body.error).every((k) => ["code", "message", "details"].includes(k))).toBe(true);
}

describe("hidden rules: pagination", () => {
  it("uses the standard error shape for an invalid limit and an invalid cursor", async () => {
    const api = setup();
    await api.create({ title: "A" });
    expectError(await api.get(`/tasks?limit=0`), 400, "VALIDATION_ERROR");
    expectError(await api.get(`/tasks?cursor=garbage`), 400, "VALIDATION_ERROR");
  });

  it("never returns deleted tasks on any page", async () => {
    const api = setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await api.create({ title: `t${i}` })).id);
    await api.remove(ids[1] ?? "");
    await api.remove(ids[4] ?? "");
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor === null ? "limit=2" : `limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await api.get(`/tasks?${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.items.map((t: { id: string }) => t.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual([ids[0], ids[2], ids[3], ids[5]]);
  });

  it("returns exactly { items, nextCursor } with exactly the task fields per item", async () => {
    const api = setup();
    await api.create({ title: "A" });
    await api.create({ title: "B" });
    const res = await api.get(`/tasks?limit=1`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["items", "nextCursor"]);
    expect(typeof res.body.nextCursor).toBe("string");
    expect(res.body.items).toHaveLength(1);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(TASK_KEYS);
  });

  it("[guard] an invalid status filter is still 400 VALIDATION_ERROR", async () => {
    const api = setup();
    expectError(await api.get(`/tasks?status=archived`), 400, "VALIDATION_ERROR");
  });
});
