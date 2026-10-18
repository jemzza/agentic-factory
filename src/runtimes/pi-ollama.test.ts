import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkOllamaModel,
  numCtxOf,
  writeOllamaProvider,
  type OllamaModelPin,
} from "./pi-ollama.js";

const PIN: OllamaModelPin = {
  url: "http://127.0.0.1:11434",
  baseModel: "qwen2.5-coder:7b-instruct-q4_K_M",
  digest: "dae161e27b0e",
  model: "factory-reviewer-qwen2.5-coder-7b",
  numCtx: 32768,
  modelfile: "ollama/factory-reviewer-qwen2.5-coder-7b.Modelfile",
};
const BLOB = "/Users/x/.ollama/models/blobs/sha256-aaaa";

/** A fake Ollama: /api/tags and /api/show, shaped like Ollama 0.40.6 answers. */
function ollama(o: {
  tags?: { name: string; digest: string }[];
  derivedFrom?: string;
  numCtx?: number;
  down?: boolean;
}) {
  return vi.fn((url: string, init?: { body?: string }) => {
    if (o.down) return Promise.reject(new TypeError("fetch failed"));
    const u = url;
    if (u.endsWith("/api/tags")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: o.tags ?? [
              { name: PIN.baseModel, digest: "dae161e27b0e" + "f".repeat(52) },
              { name: `${PIN.model}:latest`, digest: "1".repeat(64) },
            ],
          }),
        ),
      );
    }
    const { model } = JSON.parse(init?.body ?? "{}") as { model: string };
    const derived = model === PIN.model;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          modelfile: `# generated\nFROM ${derived ? (o.derivedFrom ?? BLOB) : BLOB}\nTEMPLATE x\n`,
          parameters: derived
            ? `num_ctx                        ${String(o.numCtx ?? 32768)}\ntemperature 0`
            : "stop <|im_end|>",
        }),
      ),
    );
  }) as unknown as typeof fetch;
}

describe("checkOllamaModel", () => {
  it("passes for the pinned base digest and a derived model with the configured num_ctx", async () => {
    expect(await checkOllamaModel(PIN, ollama({}))).toEqual({ ok: true });
  });

  it("Ollama unreachable is infra; a missing or different model is a process error with the fix", async () => {
    expect(await checkOllamaModel(PIN, ollama({ down: true }))).toMatchObject({
      ok: false,
      kind: "infra",
      message: expect.stringMatching(/not reachable.*brew services start ollama/) as unknown,
    });
    expect(await checkOllamaModel(PIN, ollama({ tags: [] }))).toMatchObject({
      kind: "process",
      message: expect.stringContaining("ollama pull qwen2.5-coder:7b-instruct-q4_K_M") as unknown,
    });
    expect(
      await checkOllamaModel(
        PIN,
        ollama({ tags: [{ name: PIN.baseModel, digest: "0".repeat(64) }] }),
      ),
    ).toMatchObject({ kind: "process", message: expect.stringMatching(/tag moved/) as unknown });
    expect(
      await checkOllamaModel(
        PIN,
        ollama({ tags: [{ name: PIN.baseModel, digest: "dae161e27b0e" + "0".repeat(52) }] }),
      ),
    ).toMatchObject({
      kind: "process",
      message: expect.stringContaining(`ollama create ${PIN.model} -f ${PIN.modelfile}`) as unknown,
    });
    expect(await checkOllamaModel(PIN, ollama({ derivedFrom: "/other/blob" }))).toMatchObject({
      kind: "process",
      message: expect.stringMatching(/not built from/) as unknown,
    });
    expect(await checkOllamaModel(PIN, ollama({ numCtx: 2048 }))).toMatchObject({
      kind: "process",
      message: expect.stringMatching(/num_ctx 2048.*needs 32768/) as unknown,
    });
  });

  it("reads num_ctx from Ollama's parameters text (live shape)", () => {
    expect(numCtxOf("num_ctx                        8192")).toBe(8192);
    expect(numCtxOf("temperature 0")).toBeNull();
  });
});

describe("writeOllamaProvider", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "factory-pi-ollama-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the 127.0.0.1 ollama provider at $0 and keeps other providers", async () => {
    await writeFile(
      path.join(dir, "models.json"),
      JSON.stringify({ providers: { other: { x: 1 } } }),
    );
    await writeOllamaProvider(dir, PIN);
    const json = JSON.parse(await readFile(path.join(dir, "models.json"), "utf8")) as {
      providers: Record<
        string,
        { baseUrl?: string; models?: { id: string; contextWindow: number }[] }
      >;
    };
    expect(json.providers["other"]).toEqual({ x: 1 });
    expect(json.providers["ollama"]).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: PIN.model, contextWindow: 32768 }],
    });
  });
});
