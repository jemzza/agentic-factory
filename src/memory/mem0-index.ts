import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FACTORY_ROOT } from "../paths.js";
import { embedModelId, type MemoryConfig } from "../schemas/config.js";
import type { VectorIndex } from "./indexed.js";
import { MemoryUnavailableError } from "./types.js";

/*
 * The vector index on Mem0 OSS (mem0ai 3.3.1, verified live 2026-10-18 against Ollama 0.40.6
 * with nomic-embed-text:latest @ 0a109f422b47):
 * - `add(..., { infer: false })` stores the text as given and embeds it; Mem0's LLM is never
 *   called (the factory's planner writes the rule). The constructor still builds an LLM
 *   client, so the LLM slot is an OpenAI-compatible client on a closed local port: building it
 *   makes no request, and an accidental call cannot leave the machine. (Mem0's own `ollama`
 *   LLM provider would start pulling its model at construction — never use it here.)
 * - vectors live in Mem0's SQLite vector store under data/memory/ (dbPath), history is off;
 * - telemetry (PostHog) is disabled with MEM0_TELEMETRY=false before the module loads;
 * - projects are separated by Mem0's `userId` = projectId (filters.user_id on search).
 * The only host contacted in the live probe was 127.0.0.1:11434.
 */

const TagsSchema = z.looseObject({
  models: z.array(z.looseObject({ name: z.string(), digest: z.string() })),
});

interface Mem0Like {
  add(
    messages: { role: string; content: string }[],
    config: Record<string, unknown>,
  ): Promise<unknown>;
  search(query: string, config: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  reset(): Promise<void>;
}

const AddResultSchema = z.looseObject({
  results: z.array(z.looseObject({ id: z.string() })).min(1),
});
const SearchResultSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      id: z.string(),
      score: z.number().optional(),
      metadata: z.looseObject({ factoryId: z.string().optional() }).nullish(),
    }),
  ),
});

export class Mem0Index implements VectorIndex {
  readonly embedModel: string;
  readonly dims: number;
  private mem: Promise<Mem0Like> | null = null;

  constructor(
    private readonly config: MemoryConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.embedModel = embedModelId(config.embedder);
    this.dims = config.embedder.dims;
  }

  /** The embedder can be used: Ollama answers on 127.0.0.1 with the pinned model and digest. */
  async check(): Promise<void> {
    const e = this.config.embedder;
    if (e.provider === "openai") {
      if (!this.env[e.keyEnv])
        throw new MemoryUnavailableError(`${e.keyEnv} is not set (OpenAI embedder)`);
      return;
    }
    let body: unknown;
    try {
      const res = await fetch(`${e.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      body = await res.json();
    } catch (err) {
      throw new MemoryUnavailableError(
        `Ollama is not reachable at ${e.url} (${err instanceof Error ? err.message : String(err)}); start it with \`brew services start ollama\``,
      );
    }
    const tags = TagsSchema.safeParse(body);
    if (!tags.success) throw new MemoryUnavailableError(`unexpected answer from ${e.url}/api/tags`);
    const model = tags.data.models.find((m) => m.name === e.model);
    if (!model) {
      throw new MemoryUnavailableError(
        `Ollama has no model ${e.model}; run \`ollama pull ${e.model}\``,
      );
    }
    if (!model.digest.startsWith(e.digest)) {
      throw new MemoryUnavailableError(
        `Ollama's ${e.model} is digest ${model.digest.slice(0, 12)}, the config pins ${e.digest}: ` +
          "the tag moved to another model. Pin the new digest in factory.config.ts, then run " +
          "`npm run memory -- reindex` (vectors of different models cannot be mixed).",
      );
    }
  }

  private memory(): Promise<Mem0Like> {
    this.mem ??= (async () => {
      process.env["MEM0_TELEMETRY"] = "false"; // read when the module loads
      const { Memory } = await import("mem0ai/oss");
      const dir = path.resolve(FACTORY_ROOT, this.config.indexDir);
      mkdirSync(dir, { recursive: true });
      const e = this.config.embedder;
      const embedder =
        e.provider === "ollama"
          ? { provider: "ollama", config: { url: e.url, model: e.model, embeddingDims: e.dims } }
          : {
              provider: "openai",
              config: { apiKey: this.env[e.keyEnv] ?? "", model: e.model, embeddingDims: e.dims },
            };
      return new Memory({
        embedder,
        vectorStore: {
          provider: "memory",
          config: {
            collectionName: "factory",
            dimension: e.dims,
            dbPath: path.join(dir, "vector_store.db"),
          },
        },
        llm: {
          provider: "openai",
          config: {
            apiKey: "unused-infer-false",
            baseURL: "http://127.0.0.1:9/v1",
            model: "unused",
          },
        },
        disableHistory: true,
      });
    })();
    return this.mem;
  }

  private async call<T>(what: string, fn: (m: Mem0Like) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.memory());
    } catch (err) {
      throw new MemoryUnavailableError(
        `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async add(projectId: string, text: string, factoryId: string): Promise<string> {
    const raw = await this.call("memory add", (m) =>
      m.add([{ role: "user", content: text }], {
        userId: projectId,
        infer: false,
        metadata: { factoryId },
      }),
    );
    const parsed = AddResultSchema.safeParse(raw);
    if (!parsed.success)
      throw new MemoryUnavailableError("memory add: unexpected result from Mem0");
    return parsed.data.results[0]?.id ?? "";
  }

  async search(projectId: string, query: string, k: number) {
    const raw = await this.call("memory search", (m) =>
      m.search(query, { filters: { user_id: projectId }, topK: k }),
    );
    const parsed = SearchResultSchema.safeParse(raw);
    if (!parsed.success)
      throw new MemoryUnavailableError("memory search: unexpected result from Mem0");
    return parsed.data.results.flatMap((r) =>
      r.metadata?.factoryId ? [{ factoryId: r.metadata.factoryId, score: r.score ?? 0 }] : [],
    );
  }

  async delete(indexId: string): Promise<void> {
    await this.call("memory delete", (m) => m.delete(indexId));
  }

  async reset(): Promise<void> {
    await this.call("memory reset", (m) => m.reset());
  }
}
