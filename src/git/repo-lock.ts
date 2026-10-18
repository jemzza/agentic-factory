import path from "node:path";

/**
 * Serializes the git operations that change a project clone's shared state — worktree
 * add/remove/prune, tags, the merge into the target branch, fetch and push — while runs of the
 * same project execute in parallel (`--concurrency N`). Different projects never wait for each
 * other. Work inside a run's own worktree (edits, snapshots) does not take the lock: git keeps
 * per-worktree HEADs and per-branch ref locks, and `gc.auto` is off for factory git calls.
 *
 * In-process only: one factory process drives a project at a time (factory:watch holds a
 * single-instance lock; eval uses its own fixture clone).
 */
const tails = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoDir);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
