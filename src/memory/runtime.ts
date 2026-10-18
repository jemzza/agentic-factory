import { secretsFromEnv } from "../store/redact.js";
import type { Store } from "../store/store.js";
import type { ResolvedConfig } from "../config/load-config.js";
import { IndexedMemory } from "./indexed.js";
import { Mem0Index } from "./mem0-index.js";
import { MemoryUnavailableError, type ProjectMemory } from "./types.js";

/**
 * What a run gets for project memory. `memory: null` means it is enabled but cannot be used
 * right now (`unavailable` says why): an ordinary run continues without it and says so in its
 * report and PR; a run that requires it (eval:memory, condition memory_on) ends infra_error,
 * so that memory_on can never silently become memory_off.
 */
export interface MemoryAccess {
  memory: ProjectMemory | null;
  unavailable: string | null;
  limit: number;
  required: boolean;
}

/**
 * Opens project memory per the config, or returns undefined when it is disabled. An index
 * built with another embedder is a hard error (reindex first); an unreachable backend is not.
 */
export async function openMemory(
  config: ResolvedConfig,
  store: Store,
  opts: { required?: boolean; force?: boolean } = {},
): Promise<MemoryAccess | undefined> {
  if (!config.memory.enabled && !opts.force) return undefined;
  const memory = new IndexedMemory(store, new Mem0Index(config.memory), {
    indexName: "mem0",
    secrets: secretsFromEnv(config.secretEnv),
  });
  const base = { limit: config.memory.limit, required: opts.required ?? false };
  try {
    await memory.open();
    return { ...base, memory, unavailable: null };
  } catch (err) {
    if (err instanceof MemoryUnavailableError)
      return { ...base, memory: null, unavailable: err.message };
    throw err; // e.g. MemoryIndexMismatchError: never run on a mixed index
  }
}
