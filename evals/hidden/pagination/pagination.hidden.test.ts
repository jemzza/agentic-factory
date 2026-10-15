import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

type Api = ReturnType<typeof setup>;

async function seed(api: Api, count: number, status?: (i: number) => string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const body: Record<string, unknown> = { title: `task ${String(i).padStart(3, "0")}` };
    if (status) body["status"] = status(i);
    ids.push((await api.create(body)).id);
  }
  return ids;
}

async function page(api: Api, query: string) {
  const res = await api.get(`/tasks${query}`);
  expect(res.status).toBe(200);
  return res.body as { items: { id: string; title: string }[]; nextCursor: string | null };
}

async function walk(api: Api, base: string, limit?: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams(base);
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor !== null) params.set("cursor", cursor);
    const qs = params.toString();
    const p = await page(api, qs ? `?${qs}` : "");
    ids.push(...p.items.map((t) => t.id));
    cursor = p.nextCursor;
    pages++;
    if (pages > 50) throw new Error("pagination does not terminate");
  } while (cursor !== null);
  return { ids, pages };
}

describe("hidden: pagination", () => {
  it("returns { items, nextCursor: null } for a short list", async () => {
    const api = setup();
    const ids = await seed(api, 3);
    const p = await page(api, "");
    expect(p.items.map((t) => t.id)).toEqual(ids);
    expect(p.nextCursor).toBeNull();
  });

  it("returns an empty first page with nextCursor null", async () => {
    const api = setup();
    expect(await page(api, "")).toEqual({ items: [], nextCursor: null });
  });

  it("defaults to 20 per page and walks all tasks in creation order", async () => {
    const api = setup();
    const ids = await seed(api, 45);
    const first = await page(api, "");
    expect(first.items).toHaveLength(20);
    expect(typeof first.nextCursor).toBe("string");

    const all = await walk(api, "");
    expect(all.ids).toEqual(ids);
    expect(all.pages).toBe(3);
  });

  it("honors limit, including the bounds 1 and 100", async () => {
    const api = setup();
    const ids = await seed(api, 101);
    expect((await page(api, "?limit=1")).items.map((t) => t.id)).toEqual([ids[0]]);
    expect((await page(api, "?limit=100")).items).toHaveLength(100);
    const all = await walk(api, "", 7);
    expect(all.ids).toEqual(ids);
  });

  it("returns nextCursor null when the last page is exactly full", async () => {
    const api = setup();
    const ids = await seed(api, 10);
    const first = await page(api, "?limit=5");
    const second = await page(api, `?limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((t) => t.id)).toEqual(ids.slice(5));
    // Either null here, or an empty final page with null.
    if (second.nextCursor !== null) {
      const third = await page(api, `?limit=5&cursor=${encodeURIComponent(second.nextCursor)}`);
      expect(third).toEqual({ items: [], nextCursor: null });
    }
  });

  it.each(["0", "101", "-1", "1.5", "abc", ""])("rejects limit=%s with 400 VALIDATION_ERROR", async (limit) => {
    const api = setup();
    await seed(api, 2);
    const res = await api.get(`/tasks?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it.each(["garbage", "eyJ4IjoxfQ", "%00%01", ""])("rejects cursor=%s with 400 VALIDATION_ERROR", async (cursor) => {
    const api = setup();
    await seed(api, 2);
    const res = await api.get(`/tasks?cursor=${cursor}`);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("paginates together with the status filter", async () => {
    const api = setup();
    const ids = await seed(api, 30, (i) => (i % 3 === 0 ? "done" : "todo"));
    const done = ids.filter((_, i) => i % 3 === 0);
    const all = await walk(api, "status=done", 4);
    expect(all.ids).toEqual(done);
  });

  it("does not skip tasks when the last task of a page is deleted before fetching the next page", async () => {
    const api = setup();
    const ids = await seed(api, 10);
    const first = await page(api, "?limit=3");
    expect(first.items.map((t) => t.id)).toEqual(ids.slice(0, 3));
    await api.remove(ids[2]!);
    const second = await page(api, `?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((t) => t.id)).toEqual(ids.slice(3, 6));
  });

  it("does not skip or repeat tasks when earlier tasks are deleted between pages", async () => {
    const api = setup();
    const ids = await seed(api, 10);
    const first = await page(api, "?limit=4");
    await api.remove(ids[0]!);
    await api.remove(ids[1]!);
    const second = await page(api, `?limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((t) => t.id)).toEqual(ids.slice(4, 8));
  });

  it("does not repeat tasks when new tasks are created between pages", async () => {
    const api = setup();
    const ids = await seed(api, 6);
    const first = await page(api, "?limit=3");
    const extra = await api.create({ title: "late arrival" });
    const second = await page(api, `?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((t) => t.id)).toEqual(ids.slice(3, 6));
    const third = second.nextCursor
      ? await page(api, `?limit=3&cursor=${encodeURIComponent(second.nextCursor)}`)
      : { items: [] };
    expect(third.items.map((t) => t.id)).toEqual([extra.id]);
  });
});
