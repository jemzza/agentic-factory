import type { ResolvedConfig } from "../config/load-config.js";
import { Mem0Index } from "../memory/mem0-index.js";
import { checkOllamaModel } from "./pi-ollama.js";

/*
 * `npm run provider:check -- <openai|ollama>`: is a provider usable, before any run uses it.
 * - openai: without the key, a clear message and nothing is called (exit 2). With the key, one
 *   free request (GET /v1/models): 401 = the key is rejected (exit 1); 429, 5xx or no network =
 *   the provider is unavailable (exit 3). The key itself is never printed.
 * - ollama: the local models the config pins (the Pi reviewer's, the memory embedder's), on
 *   127.0.0.1 only.
 */

export const OPENAI_KEY_ENV = "OPENAI_API_KEY";

export interface CheckLine {
  ok: boolean;
  what: string;
  detail: string;
}
export interface ProviderCheck {
  exitCode: 0 | 1 | 2 | 3;
  lines: CheckLine[];
}

export async function checkOpenAI(
  env: NodeJS.ProcessEnv,
  f: typeof fetch = fetch,
): Promise<ProviderCheck> {
  const key = env[OPENAI_KEY_ENV];
  if (!key) {
    return {
      exitCode: 2,
      lines: [
        {
          ok: false,
          what: "openai",
          detail: `${OPENAI_KEY_ENV} is not set. Put it in .env (git-ignored), then run this check again; nothing was called. How to enable OpenAI without code changes: docs/enable-openai.md`,
        },
      ],
    };
  }
  let res: Response;
  try {
    res = await f("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      exitCode: 3,
      lines: [
        {
          ok: false,
          what: "openai",
          detail: `api.openai.com is not reachable (${err instanceof Error ? err.message : String(err)})`,
        },
      ],
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      exitCode: 1,
      lines: [
        { ok: false, what: "openai", detail: `the key was rejected (HTTP ${String(res.status)})` },
      ],
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return {
      exitCode: 3,
      lines: [
        {
          ok: false,
          what: "openai",
          detail: `provider unavailable (HTTP ${String(res.status)}: rate limit, quota or outage)`,
        },
      ],
    };
  }
  if (!res.ok) {
    return {
      exitCode: 1,
      lines: [{ ok: false, what: "openai", detail: `unexpected HTTP ${String(res.status)}` }],
    };
  }
  return {
    exitCode: 0,
    lines: [
      {
        ok: true,
        what: "openai",
        detail: `${OPENAI_KEY_ENV} accepted (GET /v1/models, no tokens spent). Quota and billing are not checked: an exhausted budget shows only on a model call`,
      },
    ],
  };
}

export async function checkOllama(
  config: ResolvedConfig,
  f: typeof fetch = fetch,
): Promise<ProviderCheck> {
  const lines: CheckLine[] = [];
  const bindings = [
    ...Object.entries(config.roles).map(([r, b]) => [`roles.${r}`, b] as const),
    ...config.reviewEval.reviewers.map(
      (b, i) => [`reviewEval.reviewers[${String(i)}]`, b] as const,
    ),
  ];
  const seen = new Set<string>();
  for (const [where, b] of bindings) {
    if (!b.ollama || seen.has(b.model)) continue;
    seen.add(b.model);
    const r = await checkOllamaModel({ ...b.ollama, model: b.model.slice("ollama/".length) }, f);
    lines.push({
      ok: r.ok,
      what: `${where} pi:${b.model}`,
      detail: r.ok
        ? `${b.ollama.baseModel} @ ${b.ollama.digest}, num_ctx ${String(b.ollama.numCtx)}`
        : r.message,
    });
  }
  if (config.memory.embedder.provider === "ollama") {
    try {
      await new Mem0Index(config.memory).check();
      lines.push({
        ok: true,
        what: "memory embedder",
        detail: `${config.memory.embedder.model} @ ${config.memory.embedder.digest}`,
      });
    } catch (err) {
      lines.push({
        ok: false,
        what: "memory embedder",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (lines.length === 0)
    lines.push({ ok: true, what: "ollama", detail: "the config pins no Ollama model" });
  return { exitCode: lines.every((l) => l.ok) ? 0 : 1, lines };
}
