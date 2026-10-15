import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

async function titles(api: ReturnType<typeof setup>, query: string): Promise<string[]> {
  const res = await api.get(`/tasks?${query}`);
  expect(res.status).toBe(200);
  return res.body.items.map((t: { title: string }) => t.title);
}

describe("hidden: search-tasks", () => {
  it("matches a case-insensitive substring of the title", async () => {
    const api = setup();
    await api.create({ title: "Write Docs" });
    await api.create({ title: "Review docs PR" });
    await api.create({ title: "Deploy" });
    expect(await titles(api, "q=DOCS")).toEqual(["Write Docs", "Review docs PR"]);
    expect(await titles(api, "q=nothing")).toEqual([]);
  });

  it("trims q", async () => {
    const api = setup();
    await api.create({ title: "Write Docs" });
    await api.create({ title: "Deploy" });
    expect(await titles(api, `q=${encodeURIComponent("  deploy  ")}`)).toEqual(["Deploy"]);
  });

  it("treats regex metacharacters literally", async () => {
    const api = setup();
    await api.create({ title: "Learn C++" });
    await api.create({ title: "Learn C" });
    await api.create({ title: "Fix (urgent) bug" });
    await api.create({ title: "a.b" });
    await api.create({ title: "axb" });
    expect(await titles(api, `q=${encodeURIComponent("c++")}`)).toEqual(["Learn C++"]);
    expect(await titles(api, `q=${encodeURIComponent("(urgent")}`)).toEqual(["Fix (urgent) bug"]);
    expect(await titles(api, `q=${encodeURIComponent("a.b")}`)).toEqual(["a.b"]);
    const star = await api.get(`/tasks?q=${encodeURIComponent("*")}`);
    expect(star.status).toBe(200);
    expect(star.body.items).toEqual([]);
  });

  it("rejects an empty or whitespace-only q with 400 VALIDATION_ERROR", async () => {
    const api = setup();
    for (const q of ["", "%20%20"]) {
      const res = await api.get(`/tasks?q=${q}`);
      expect(res.status).toBe(400);
      expect(errorCode(res)).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects q longer than 100 characters, accepts exactly 100", async () => {
    const api = setup();
    const tooLong = await api.get(`/tasks?q=${"x".repeat(101)}`);
    expect(tooLong.status).toBe(400);
    expect(errorCode(tooLong)).toBe("VALIDATION_ERROR");
    const max = await api.get(`/tasks?q=${"x".repeat(100)}`);
    expect(max.status).toBe(200);
  });

  it("combines with the status filter", async () => {
    const api = setup();
    await api.create({ title: "docs one", status: "done" });
    await api.create({ title: "docs two", status: "todo" });
    await api.create({ title: "other", status: "done" });
    expect(await titles(api, "q=docs&status=done")).toEqual(["docs one"]);
  });

  it("excludes deleted tasks", async () => {
    const api = setup();
    const a = await api.create({ title: "docs one" });
    await api.create({ title: "docs two" });
    await api.remove(a.id);
    expect(await titles(api, "q=docs")).toEqual(["docs two"]);
  });

  it("keeps the unfiltered list unchanged", async () => {
    const api = setup();
    await api.create({ title: "A" });
    await api.create({ title: "B" });
    expect(await titles(api, "")).toEqual(["A", "B"]);
  });
});
