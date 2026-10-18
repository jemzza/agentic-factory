import { randomUUID } from "node:crypto";
import { assertWritable } from "./guard.js";
import type { VectorIndex } from "./indexed.js";
import {
  MemoryUnavailableError,
  type MemoryHit,
  type MemoryRecord,
  type NewMemory,
  type ProjectMemory,
} from "./types.js";

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Word-overlap similarity (Jaccard); good enough to order records in tests. */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.max(1, x.size + y.size - common);
}

/** ProjectMemory for tests: everything in a Map, same rules as the real one. */
export class InMemoryMemory implements ProjectMemory {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly byKey = new Map<string, MemoryRecord>();
  constructor(private readonly embedModel = "test/words") {}

  add(projectId: string, m: NewMemory): Promise<MemoryRecord> {
    try {
      assertWritable(m);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const dup = m.dedupeKey ? this.byKey.get(m.dedupeKey) : undefined;
    if (dup) return Promise.resolve(dup);
    const r: MemoryRecord = {
      id: randomUUID(),
      projectId,
      text: m.text.trim(),
      source: m.source,
      runId: m.runId,
      createdAt: new Date().toISOString(),
      embedModel: this.embedModel,
    };
    this.records.set(r.id, r);
    if (m.dedupeKey) this.byKey.set(m.dedupeKey, r);
    return Promise.resolve(r);
  }

  search(projectId: string, query: string, limit: number): Promise<MemoryHit[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((r) => r.projectId === projectId)
        .map((record) => ({ record, score: overlap(query, record.text) }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit),
    );
  }

  remove(projectId: string, id: string): Promise<boolean> {
    const r = this.records.get(id);
    if (r?.projectId !== projectId) return Promise.resolve(false);
    return Promise.resolve(this.records.delete(id));
  }

  list(projectId: string): Promise<MemoryRecord[]> {
    return Promise.resolve([...this.records.values()].filter((r) => r.projectId === projectId));
  }
}

/** A VectorIndex for tests (word overlap); can be "down" to test the unavailable path. */
export class FakeVectorIndex implements VectorIndex {
  private readonly items = new Map<
    string,
    { projectId: string; text: string; factoryId: string }
  >();
  down = false;
  constructor(
    readonly embedModel = "test/words@0",
    readonly dims = 1,
  ) {}

  check(): Promise<void> {
    return this.down
      ? Promise.reject(new MemoryUnavailableError("fake index is down"))
      : Promise.resolve();
  }

  async add(projectId: string, text: string, factoryId: string): Promise<string> {
    await this.check();
    const id = `v-${this.items.size + 1}-${factoryId.slice(0, 8)}`;
    this.items.set(id, { projectId, text, factoryId });
    return id;
  }

  async search(projectId: string, query: string, k: number) {
    await this.check();
    return [...this.items.values()]
      .filter((i) => i.projectId === projectId)
      .map((i) => ({ factoryId: i.factoryId, score: overlap(query, i.text) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  delete(indexId: string): Promise<void> {
    this.items.delete(indexId);
    return Promise.resolve();
  }

  reset(): Promise<void> {
    this.items.clear();
    return Promise.resolve();
  }

  size(): number {
    return this.items.size;
  }
}
