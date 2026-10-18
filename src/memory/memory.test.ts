import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../schemas/config.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import { assertWritable } from "./guard.js";
import { FakeVectorIndex, InMemoryMemory } from "./in-memory.js";
import { IndexedMemory } from "./indexed.js";
import { Mem0Index } from "./mem0-index.js";
import {
  ForbiddenMemoryError,
  MemoryIndexMismatchError,
  MemoryUnavailableError,
  type NewMemory,
  type ProjectMemory,
} from "./types.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-memory-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const rule = (text: string, extra: Partial<NewMemory> = {}): NewMemory => ({
  text,
  source: "manual",
  runId: null,
  origin: { kind: "cli" },
  ...extra,
});

let n = 0;
const newStore = () => new Store(openDb(path.join(tmp, `m-${++n}.db`)));

describe("what may never be stored", () => {
  it.each([
    ["hidden tests", "The hidden tests in evals/hidden/complete-task check 400"],
    ["hidden test files", "see tests/__hidden__/x.rules.hidden.test.ts"],
    ["hidden test results", "hidden tests: 8/9 passed"],
    ["reference implementations", "copy the reference implementation of restore"],
    ["raw logs", '{"type":"result","subtype":"success"}'],
    ["diffs", "diff --git a/src/x.ts b/src/x.ts"],
    ["token shapes", "use ghp_abcdefghijklmnopqrstuvwxyz0123 to push"],
    ["key shapes", "OPENAI key sk-proj-abcdefghijklmnopqrstu"],
  ])("refuses %s", (_name, text) => {
    expect(() => {
      assertWritable(rule(text));
    }).toThrow(ForbiddenMemoryError);
  });

  it("refuses configured secret values, text of users who are not allowed, and rejections not made by a human", () => {
    expect(() => {
      assertWritable(rule("the deploy password is hunter2-very-secret"), ["hunter2-very-secret"]);
    }).toThrow(/secret/);
    expect(() => {
      assertWritable(
        rule("always use tabs", { origin: { kind: "github", login: "mallory", allowed: false } }),
      );
    }).toThrow(/not an allowed user/);
    expect(() => {
      assertWritable(rule("x", { source: "spec_rejection_comment", origin: { kind: "factory" } }));
    }).toThrow(/human decision/);
    expect(() => {
      assertWritable(rule("x".repeat(501)));
    }).toThrow(/a rule, not a document/);
  });

  it("refuses forbidden writes in every implementation, before anything is stored", async () => {
    const store = newStore();
    const indexed = new IndexedMemory(store, new FakeVectorIndex(), { indexName: "t" });
    await indexed.open();
    for (const mem of [new InMemoryMemory(), indexed] as ProjectMemory[]) {
      await expect(mem.add("p", rule("hidden tests passed 9/9"))).rejects.toThrow(
        ForbiddenMemoryError,
      );
      expect(await mem.list("p")).toEqual([]);
    }
    expect(store.listMemories(null)).toEqual([]);
  });

  it("accepts a short confirmed rule from an allowed user", () => {
    expect(() => {
      assertWritable(
        rule("Action endpoints reject any request body field with 400 VALIDATION_ERROR.", {
          source: "spec_rejection_comment",
          origin: { kind: "github", login: "owner", allowed: true },
        }),
      );
    }).not.toThrow();
  });
});

describe("projects never see each other's memory", () => {
  it.each([
    ["InMemoryMemory", async () => Promise.resolve(new InMemoryMemory())],
    [
      "IndexedMemory",
      async () => {
        const m = new IndexedMemory(newStore(), new FakeVectorIndex(), { indexName: "t" });
        await m.open();
        return m;
      },
    ],
  ])("%s", async (_name, make) => {
    const mem: ProjectMemory = await make();
    const a = await mem.add("alpha", rule("strict request body rules for alpha endpoints"));
    await mem.add("beta", rule("strict request body rules for beta endpoints"));
    const hits = await mem.search("alpha", "strict request body", 10);
    expect(hits.map((h) => h.record.projectId)).toEqual(["alpha"]);
    expect((await mem.list("beta")).map((r) => r.projectId)).toEqual(["beta"]);
    expect(await mem.remove("beta", a.id)).toBe(false); // not beta's record
    expect(await mem.list("alpha")).toHaveLength(1);
    expect(await mem.remove("alpha", a.id)).toBe(true);
    expect(await mem.search("alpha", "strict request body", 10)).toEqual([]);
  });
});

describe("IndexedMemory", () => {
  it("records source, run, time and the embedder; a replayed write is stored once", async () => {
    const store = newStore();
    const mem = new IndexedMemory(store, new FakeVectorIndex("ollama/m:latest@aaaaaaaaaaaa"), {
      indexName: "t",
    });
    await mem.open();
    const r1 = await mem.add(
      "p",
      rule("Bulk endpoints accept at most 50 ids.", {
        source: "review_issue_fixed",
        runId: "run-1",
        origin: { kind: "factory" },
        dedupeKey: "run-1:review:0",
      }),
    );
    const r2 = await mem.add(
      "p",
      rule("Bulk endpoints accept at most 50 ids.", {
        source: "review_issue_fixed",
        runId: "run-1",
        origin: { kind: "factory" },
        dedupeKey: "run-1:review:0",
      }),
    );
    expect(r2.id).toBe(r1.id);
    expect(r1).toMatchObject({
      source: "review_issue_fixed",
      runId: "run-1",
      embedModel: "ollama/m:latest@aaaaaaaaaaaa",
    });
    expect(r1.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.listMemories("p")).toHaveLength(1);
  });

  it("refuses to start on an index built with another embedder; reindex fixes it", async () => {
    const store = newStore();
    const old = new IndexedMemory(store, new FakeVectorIndex("ollama/a:latest@111111111111"), {
      indexName: "t",
    });
    await old.open();
    await old.add("p", rule("rule one"));
    await old.add("q", rule("rule two"));
    const index = new FakeVectorIndex("ollama/b:latest@222222222222");
    const current = new IndexedMemory(store, index, { indexName: "t" });
    await expect(current.open()).rejects.toThrow(MemoryIndexMismatchError);
    await expect(current.open()).rejects.toThrow(/npm run memory -- reindex/);
    expect(await current.reindex()).toBe(2);
    await current.open();
    expect(index.size()).toBe(2);
    expect(store.listMemories(null).map((m) => m.embed_model)).toEqual([
      "ollama/b:latest@222222222222",
      "ollama/b:latest@222222222222",
    ]);
    expect((await current.search("p", "rule one", 5))[0]?.record.text).toBe("rule one");
  });

  it("reports an unreachable index as unavailable", async () => {
    const index = new FakeVectorIndex();
    index.down = true;
    await expect(new IndexedMemory(newStore(), index, { indexName: "t" }).open()).rejects.toThrow(
      MemoryUnavailableError,
    );
  });
});

describe("Mem0Index.check (Ollama on 127.0.0.1, pinned digest)", () => {
  const tags = (models: { name: string; digest: string }[]) =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ models }))));

  it("passes with the pinned model and digest", async () => {
    vi.stubGlobal("fetch", tags([{ name: "nomic-embed-text:latest", digest: "0a109f422b47ffff" }]));
    await expect(new Mem0Index(DEFAULT_MEMORY_CONFIG).check()).resolves.toBeUndefined();
  });

  it("explains a moved tag (another digest), a missing model and a stopped Ollama", async () => {
    vi.stubGlobal("fetch", tags([{ name: "nomic-embed-text:latest", digest: "ffffffffffff0000" }]));
    await expect(new Mem0Index(DEFAULT_MEMORY_CONFIG).check()).rejects.toThrow(
      /tag moved[\s\S]*reindex/,
    );
    vi.stubGlobal("fetch", tags([]));
    await expect(new Mem0Index(DEFAULT_MEMORY_CONFIG).check()).rejects.toThrow(
      /ollama pull nomic-embed-text:latest/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(new Mem0Index(DEFAULT_MEMORY_CONFIG).check()).rejects.toThrow(
      MemoryUnavailableError,
    );
  });

  it("the OpenAI variant needs its key", async () => {
    const cfg = {
      ...DEFAULT_MEMORY_CONFIG,
      embedder: {
        provider: "openai" as const,
        model: "text-embedding-3-small",
        dims: 1536,
        keyEnv: "OPENAI_API_KEY",
      },
    };
    await expect(new Mem0Index(cfg, {}).check()).rejects.toThrow(/OPENAI_API_KEY is not set/);
    expect(new Mem0Index(cfg, {}).embedModel).toBe("openai/text-embedding-3-small");
  });
});
