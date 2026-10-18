import { randomUUID } from "node:crypto";
import type { MemoryRow, Store } from "../store/store.js";
import { assertWritable } from "./guard.js";
import {
  MemoryIndexMismatchError,
  type MemoryHit,
  type MemoryRecord,
  type NewMemory,
  type ProjectMemory,
} from "./types.js";

/**
 * A vector index over memory texts (Mem0 in production, a fake in tests). It is derived data:
 * the canonical records are in SQLite and the index can always be rebuilt from them.
 */
export interface VectorIndex {
  /** Identity of the vector space (`provider/model@digest`); written into every record. */
  readonly embedModel: string;
  readonly dims: number;
  /** Throws MemoryUnavailableError when the backend cannot be used (e.g. Ollama is down). */
  check(): Promise<void>;
  add(projectId: string, text: string, factoryId: string): Promise<string>;
  search(
    projectId: string,
    query: string,
    k: number,
  ): Promise<{ factoryId: string; score: number }[]>;
  delete(indexId: string): Promise<void>;
  /** Drops every vector (before a reindex). */
  reset(): Promise<void>;
}

export const toRecord = (r: MemoryRow): MemoryRecord => ({
  id: r.id,
  projectId: r.project_id,
  text: r.text,
  source: r.source,
  runId: r.run_id,
  createdAt: r.created_at,
  embedModel: r.embed_model,
});

/**
 * ProjectMemory over the canonical SQLite table and a vector index. `open()` refuses an index
 * built with another embedder than the configured one (vectors of different models are not
 * comparable): the fix is `reindex()`, which re-embeds every active record.
 */
export class IndexedMemory implements ProjectMemory {
  constructor(
    private readonly store: Store,
    private readonly index: VectorIndex,
    private readonly opts: { indexName: string; secrets?: readonly string[] } = {
      indexName: "default",
    },
  ) {}

  /** Checks the backend and that the index matches the configured embedder. */
  async open(): Promise<void> {
    const meta = this.store.getMemoryIndex(this.opts.indexName);
    if (meta && meta.embed_model !== this.index.embedModel) {
      throw new MemoryIndexMismatchError(meta.embed_model, this.index.embedModel);
    }
    const stale = this.store
      .listMemories(null)
      .find((m) => m.embed_model !== this.index.embedModel);
    if (stale) throw new MemoryIndexMismatchError(stale.embed_model, this.index.embedModel);
    await this.index.check();
    if (!meta)
      this.store.setMemoryIndex(this.opts.indexName, this.index.embedModel, this.index.dims);
  }

  async add(projectId: string, m: NewMemory): Promise<MemoryRecord> {
    assertWritable(m, this.opts.secrets ?? []);
    const id = randomUUID();
    const { row, created } = this.store.insertMemory({
      id,
      projectId,
      text: m.text.trim(),
      source: m.source,
      runId: m.runId,
      embedModel: this.index.embedModel,
      dedupeKey: m.dedupeKey ?? null,
    });
    // A replay finds its earlier record; index it only if that did not happen yet.
    if (created || row.index_id === null) {
      const indexId = await this.index.add(projectId, row.text, row.id);
      this.store.setMemoryIndexed(row.id, indexId, this.index.embedModel);
    }
    return toRecord(row);
  }

  async search(projectId: string, query: string, limit: number): Promise<MemoryHit[]> {
    const hits = await this.index.search(projectId, query, limit);
    const out: MemoryHit[] = [];
    for (const h of hits) {
      // The canonical record decides: removed or other-project records never come back.
      const row = this.store.getMemory(projectId, h.factoryId);
      if (row && row.removed_at === null) out.push({ record: toRecord(row), score: h.score });
    }
    return out.slice(0, limit);
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const row = this.store.getMemory(projectId, id);
    if (!row || !this.store.removeMemory(projectId, id)) return false;
    if (row.index_id) await this.index.delete(row.index_id);
    return true;
  }

  list(projectId: string): Promise<MemoryRecord[]> {
    return Promise.resolve(this.store.listMemories(projectId).map(toRecord));
  }

  /** Rebuilds the whole index from the canonical records with the configured embedder. */
  async reindex(): Promise<number> {
    await this.index.check();
    await this.index.reset();
    const rows = this.store.listMemories(null);
    for (const r of rows) {
      const indexId = await this.index.add(r.project_id, r.text, r.id);
      this.store.setMemoryIndexed(r.id, indexId, this.index.embedModel);
    }
    this.store.setMemoryIndex(this.opts.indexName, this.index.embedModel, this.index.dims);
    return rows.length;
  }
}
