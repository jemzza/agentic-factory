import type { Store } from "../store/store.js";
import type { RateInfo } from "./api.js";
import type { PollSummary, Watcher } from "./watch.js";

export const WATCH_LOCK = "factory:watch";

/**
 * Delay before the next poll: the interval, stretched when the primary rate limit runs low
 * (below 10 % remaining: wait for the reset, as GitHub's docs prescribe) or when GitHub asked
 * to back off (retry-after).
 */
export function nextPollDelaySeconds(
  intervalSeconds: number,
  rate: RateInfo,
  nowSec: number,
): number {
  if (rate.retryAfter !== null) return Math.max(intervalSeconds, rate.retryAfter);
  if (rate.remaining !== null && rate.limit !== null && rate.remaining < rate.limit * 0.1) {
    return Math.max(intervalSeconds, (rate.resetAt ?? nowSec + intervalSeconds) - nowSec);
  }
  return intervalSeconds;
}

export interface DaemonOptions {
  store: Store;
  watcher: Watcher;
  rate: () => RateInfo;
  intervalSeconds: number;
  /** One poll, then exit (`--once`). */
  once: boolean;
  log: (m: string) => void;
  /** Becomes true on the first Ctrl+C. */
  stopRequested: () => boolean;
  sleep: (ms: number, stopRequested: () => boolean) => Promise<void>;
}

/**
 * The watch loop. One instance per database (named lock; a lock left by a dead process is
 * taken over). On start, runs a dead process left mid-node resume from their checkpoints.
 * Ctrl+C: no new work is taken; the current node finishes and its checkpoint is written.
 */
export async function runDaemon(
  o: DaemonOptions,
): Promise<{ polls: number; last: PollSummary | null }> {
  const lock = o.store.acquireNamedLock(WATCH_LOCK);
  if (!lock.ok) throw new Error(`factory:watch is already running (${lock.holder})`);
  let polls = 0;
  let last: PollSummary | null = null;
  try {
    await o.watcher.resumeInterrupted();
    while (!o.stopRequested()) {
      last = await o.watcher.pollOnce();
      polls++;
      o.log(
        `poll ${polls}: ${last.issues} issue(s), ${last.comments} comment(s), ${last.executed} command(s) executed, ${last.ignored} ignored${last.errors.length ? `, ${last.errors.length} error(s)` : ""}; rate ${o.rate().remaining ?? "?"}/${o.rate().limit ?? "?"}`,
      );
      if (o.once) break;
      const delay = nextPollDelaySeconds(
        o.intervalSeconds,
        o.rate(),
        Math.floor(Date.now() / 1000),
      );
      await o.sleep(delay * 1000, o.stopRequested);
    }
  } finally {
    o.store.releaseNamedLock(WATCH_LOCK);
  }
  return { polls, last };
}
