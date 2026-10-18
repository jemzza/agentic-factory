import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

async function seed(api: ReturnType<typeof setup>, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await api.create({ title: `t${i}` })).id);
  return ids;
}

describe("hidden: bulk-complete", () => {
  it("marks every listed task done, bumps updatedAt, returns them in ids order", async () => {
    const api = setup();
    const [a, b, c] = await seed(api, 3);
    api.clock.advance(1000);
    const res = await api.post(`/tasks/bulk-complete`, { ids: [c, a] });
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([c, a]);
    for (const t of res.body.items) expect(t).toMatchObject({ status: "done", updatedAt: api.clock.iso() });
    expect((await api.get(`/tasks/${b ?? ""}`)).body.status).toBe("todo");
  });

  it("validates ids and changes nothing on 404 / 409", async () => {
    const api = setup();
    const [a, b] = await seed(api, 2);
    expect(errorCode(await api.post(`/tasks/bulk-complete`, { ids: [] }))).toBe("VALIDATION_ERROR");
    expect(errorCode(await api.post(`/tasks/bulk-complete`, { ids: [a, a] }))).toBe("VALIDATION_ERROR");
    expect(errorCode(await api.post(`/tasks/bulk-complete`, { ids: [a, "nope"] }))).toBe("NOT_FOUND");
    await api.remove(b ?? "");
    expect(errorCode(await api.post(`/tasks/bulk-complete`, { ids: [a, b] }))).toBe("CONFLICT");
    expect((await api.get(`/tasks/${a ?? ""}`)).body.status).toBe("todo");
  });

  it("[lesson] accepts at most 50 ids: 50 is fine, 51 is 400 VALIDATION_ERROR", async () => {
    const api = setup();
    const ids = await seed(api, 51);
    const tooMany = await api.post(`/tasks/bulk-complete`, { ids });
    expect(tooMany.status).toBe(400);
    expect(errorCode(tooMany)).toBe("VALIDATION_ERROR");
    expect((await api.post(`/tasks/bulk-complete`, { ids: ids.slice(0, 50) })).status).toBe(200);
  });
});
