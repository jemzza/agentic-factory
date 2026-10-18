import type { MemorySource } from "../store/store.js";

export type { MemorySource };
export { MEMORY_SOURCES } from "../store/store.js";

/** One piece of project knowledge, as stored canonically in SQLite. */
export interface MemoryRecord {
  id: string;
  projectId: string;
  text: string;
  source: MemorySource;
  runId: string | null;
  createdAt: string;
  /** Embedder whose vectors the record has in the index (`provider/model@digest`). */
  embedModel: string;
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
}

/**
 * Where the text of a record comes from. Only confirmed knowledge is written: a rejection
 * comment of an allowed user (generalized by the planner), a reviewer finding whose fix then
 * passed gate and review, a decision of a merged spec, or a human entry.
 */
export type MemoryOrigin =
  { kind: "github"; login: string; allowed: boolean } | { kind: "cli" } | { kind: "factory" };

export interface NewMemory {
  text: string;
  source: MemorySource;
  runId: string | null;
  origin: MemoryOrigin;
  /** Writes with the same key are stored once (replays after a crash). */
  dedupeKey?: string;
}

/**
 * Project memory. Every call names its project; projects never see each other's records.
 */
export interface ProjectMemory {
  search(projectId: string, query: string, limit: number): Promise<MemoryHit[]>;
  add(projectId: string, m: NewMemory): Promise<MemoryRecord>;
  remove(projectId: string, id: string): Promise<boolean>;
  list(projectId: string): Promise<MemoryRecord[]>;
}

/** The memory backend cannot be used right now (e.g. Ollama is not running). */
export class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

/** The index was built with another embedder than the config names: reindex first. */
export class MemoryIndexMismatchError extends Error {
  constructor(
    readonly indexModel: string,
    readonly configModel: string,
  ) {
    super(
      `the memory index was built with ${indexModel}, but the config names ${configModel}; ` +
        "vectors of different models cannot be mixed. Rebuild it from the canonical records: " +
        "npm run memory -- reindex",
    );
    this.name = "MemoryIndexMismatchError";
  }
}

/** A write the rules forbid (hidden tests, secrets, raw logs, untrusted text, ...). */
export class ForbiddenMemoryError extends Error {
  constructor(reason: string) {
    super(`refusing to store this in project memory: ${reason}`);
    this.name = "ForbiddenMemoryError";
  }
}
