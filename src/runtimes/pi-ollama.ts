import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/*
 * Pi on a local Ollama model (Week 3 Phase 7, owner's decision: Pi reviewer on Ollama).
 *
 * Ollama's OpenAI-compatible /v1 cannot set the context size per request, so the factory uses a
 * derived model created from a Modelfile in this repository (`ollama/*.Modelfile`: FROM the
 * pinned base tag, PARAMETER num_ctx, temperature 0). Before every run the factory checks, on
 * 127.0.0.1 only:
 * - the base tag is present with the pinned digest (a moved tag is refused, like the memory
 *   embedder);
 * - the derived model exists, is built FROM the same weights blob as the base, and has the
 *   configured num_ctx.
 * Responses used (Ollama 0.40.6, checked live 2026-10-18): GET /api/tags → {models: [{name,
 * model, digest}]}; POST /api/show {model} → {modelfile: "...FROM <blob path>...", parameters:
 * "num_ctx   8192\n..."}.
 * Ollama unreachable → `infra` (provider unavailable); model missing or different → `process`
 * with the owner's command to fix it.
 */

export interface OllamaModelPin {
  /** http://127.0.0.1:<port> (never another host). */
  url: string;
  /** Base tag pulled by the owner, e.g. "qwen2.5-coder:7b-instruct-q4_K_M". */
  baseModel: string;
  /** First 12 hex characters of the base tag's digest. */
  digest: string;
  /** Derived model name (as Pi's model id after "ollama/"). */
  model: string;
  /** Context size the derived model must have. */
  numCtx: number;
  /** The Modelfile the derived model is created from (for the fix hint). */
  modelfile: string;
}

export type OllamaCheck = { ok: true } | { ok: false; kind: "infra" | "process"; message: string };

const TagsSchema = z.looseObject({
  models: z.array(z.looseObject({ name: z.string(), digest: z.string() })),
});
const ShowSchema = z.looseObject({
  modelfile: z.string().optional(),
  parameters: z.string().optional(),
});

type Fetch = typeof fetch;

const fromLine = (modelfile: string | undefined) =>
  /^FROM\s+(\S+)/m.exec(modelfile ?? "")?.[1] ?? null;

export function numCtxOf(parameters: string | undefined): number | null {
  const m = /^num_ctx\s+(\d+)/m.exec(parameters ?? "");
  return m?.[1] ? Number(m[1]) : null;
}

const withLatest = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export async function checkOllamaModel(
  pin: OllamaModelPin,
  f: Fetch = fetch,
): Promise<OllamaCheck> {
  const pull = `ollama pull ${pin.baseModel}`;
  const create = `ollama create ${pin.model} -f ${pin.modelfile}`;
  let tags: z.infer<typeof TagsSchema>;
  const show = async (model: string) =>
    ShowSchema.parse(
      await (
        await f(`${pin.url}/api/show`, {
          method: "POST",
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(5_000),
        })
      ).json(),
    );
  try {
    const res = await f(`${pin.url}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    tags = TagsSchema.parse(await res.json());
  } catch (err) {
    return {
      ok: false,
      kind: "infra",
      message: `Ollama is not reachable at ${pin.url} (${err instanceof Error ? err.message : String(err)}); start it: brew services start ollama`,
    };
  }
  const base = tags.models.find((m) => m.name === pin.baseModel);
  if (!base)
    return {
      ok: false,
      kind: "process",
      message: `base model ${pin.baseModel} is not pulled: ${pull}`,
    };
  if (!base.digest.startsWith(pin.digest)) {
    return {
      ok: false,
      kind: "process",
      message: `${pin.baseModel} has digest ${base.digest.slice(0, 12)}, the config pins ${pin.digest} (the tag moved); pin the new digest after checking it, then: ${create}`,
    };
  }
  if (!tags.models.some((m) => m.name === withLatest(pin.model))) {
    return { ok: false, kind: "process", message: `model ${pin.model} does not exist: ${create}` };
  }
  try {
    const [b, d] = [await show(pin.baseModel), await show(pin.model)];
    const bFrom = fromLine(b.modelfile);
    if (bFrom === null || bFrom !== fromLine(d.modelfile)) {
      return {
        ok: false,
        kind: "process",
        message: `model ${pin.model} is not built from ${pin.baseModel}: ${create}`,
      };
    }
    const ctx = numCtxOf(d.parameters);
    if (ctx !== pin.numCtx) {
      return {
        ok: false,
        kind: "process",
        message: `model ${pin.model} has num_ctx ${String(ctx)}, the config needs ${String(pin.numCtx)}: ${create}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      kind: "infra",
      message: `Ollama /api/show failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
}

/**
 * Writes the `ollama` provider into the factory's Pi agent dir (`models.json`), keeping any other
 * provider there. Cost is 0: the model runs locally.
 */
export async function writeOllamaProvider(agentDir: string, pin: OllamaModelPin): Promise<void> {
  const file = path.join(agentDir, "models.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) current = parsed as Record<string, unknown>;
  } catch {
    // missing or unreadable: start fresh
  }
  const providers =
    typeof current["providers"] === "object" && current["providers"] !== null
      ? (current["providers"] as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    providers: {
      ...providers,
      ollama: {
        baseUrl: `${pin.url}/v1`,
        api: "openai-completions",
        apiKey: "ollama", // Ollama ignores it; Pi needs one to list the model
        models: [
          {
            id: pin.model,
            contextWindow: pin.numCtx,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  await mkdir(agentDir, { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, file);
}
