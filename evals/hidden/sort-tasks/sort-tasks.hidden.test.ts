import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

async function titles(api: ReturnType<typeof setup>, query: string): Promise<string[]> {
  const res = await api.get(`/tasks${query}`);
  expect(res.status).toBe(200);
  return res.body.items.map((t: { title: string }) => t.title);
}

async function seed(api: ReturnType<typeof setup>) {
  const b = await api.create({ title: "banana", status: "todo" });
  api.clock.advance(1000);
  const a = await api.create({ title: "Apple", status: "done" });
  api.clock.advance(1000);
  const c = await api.create({ title: "cherry", status: "done" });
  api.clock.advance(1000);
  // Touch banana last: updatedAt order becomes Apple, cherry, banana.
  await api.patch(`/tasks/${b.id}`, { description: "touched" });
  return { a, b, c };
}

describe("hidden: sort-tasks", () => {
  it("defaults to createdAt asc", async () => {
    const api = setup();
    await seed(api);
    expect(await titles(api, "")).toEqual(["banana", "Apple", "cherry"]);
    expect(await titles(api, "?sort=createdAt&order=asc")).toEqual(["banana", "Apple", "cherry"]);
  });

  it("sorts by createdAt desc", async () => {
    const api = setup();
    await seed(api);
    expect(await titles(api, "?order=desc")).toEqual(["cherry", "Apple", "banana"]);
  });

  it("sorts by updatedAt", async () => {
    const api = setup();
    await seed(api);
    expect(await titles(api, "?sort=updatedAt")).toEqual(["Apple", "cherry", "banana"]);
    expect(await titles(api, "?sort=updatedAt&order=desc")).toEqual(["banana", "cherry", "Apple"]);
  });

  it("sorts by title case-insensitively", async () => {
    const api = setup();
    await seed(api);
    expect(await titles(api, "?sort=title")).toEqual(["Apple", "banana", "cherry"]);
    expect(await titles(api, "?sort=title&order=desc")).toEqual(["cherry", "banana", "Apple"]);
  });

  it("keeps creation order for equal keys", async () => {
    const api = setup();
    // Same clock instant for all three → equal createdAt/updatedAt.
    await api.create({ title: "x2" });
    await api.create({ title: "x1" });
    await api.create({ title: "x3" });
    expect(await titles(api, "?sort=updatedAt")).toEqual(["x2", "x1", "x3"]);
    expect(await titles(api, "?sort=createdAt&order=desc")).toEqual(["x2", "x1", "x3"]);
  });

  it("combines with the status filter", async () => {
    const api = setup();
    await seed(api);
    expect(await titles(api, "?status=done&sort=title&order=desc")).toEqual(["cherry", "Apple"]);
  });

  it.each(["?sort=priority", "?order=up", "?sort=", "?sort=TITLE"])(
    "rejects %s with 400 VALIDATION_ERROR",
    async (query) => {
      const api = setup();
      const res = await api.get(`/tasks${query}`);
      expect(res.status).toBe(400);
      expect(errorCode(res)).toBe("VALIDATION_ERROR");
    },
  );
});
