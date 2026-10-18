/**
 * A spending cap shared by parallel runs (an eval's cost cap, or factory:watch's). Before each
 * agent step the run reserves what it may spend; the reservation becomes the agent's own
 * `--max-budget-usd`, and is settled with the actual cost afterwards. Reservations are taken
 * synchronously (Node runs one callback at a time), so the sum of open reservations and
 * settled costs never exceeds the cap at reservation time.
 *
 * When the free part of the cap is too small but other steps still hold reservations, the
 * request waits for one of them to settle; when nothing is reserved and the cap is spent, it
 * is refused (the run pauses and the pool stops taking new work).
 */
export type Reservation =
  { ok: true; id: number; amountUsd: number } | { ok: false; reason: string };

/** Below this a step cannot do useful work; reserve at least this much or wait. */
export const MIN_STEP_USD = 0.05;

export class CostPool {
  private spent: number;
  private readonly open = new Map<number, { amount: number; tag: string | null }>();
  private readonly byTag = new Map<string, number>();
  private nextId = 1;
  private waiters: (() => void)[] = [];

  constructor(
    /** null: no shared cap (reservations always get what they ask for). */
    readonly capUsd: number | null,
    spentBeforeUsd = 0,
  ) {
    this.spent = spentBeforeUsd;
  }

  spentUsd(): number {
    return this.spent;
  }

  reservedUsd(): number {
    let r = 0;
    for (const v of this.open.values()) r += v.amount;
    return r;
  }

  /** True when the cap leaves less than one minimal step (new tasks should not start). */
  exhausted(): boolean {
    return this.capUsd !== null && this.capUsd - this.spent < MIN_STEP_USD;
  }

  /** What steps tagged `tag` (a run id) have settled so far. */
  spentBy(tag: string): number {
    return this.byTag.get(tag) ?? 0;
  }

  /** Books spending that did not go through a reservation (e.g. a run's cost reported later). */
  charge(usd: number, tag: string | null = null): void {
    if (usd <= 0) return;
    this.spent += usd;
    if (tag !== null) this.byTag.set(tag, this.spentBy(tag) + usd);
    this.wake();
  }

  async reserve(wantUsd: number, tag: string | null = null): Promise<Reservation> {
    for (;;) {
      const free = this.capUsd === null ? wantUsd : this.capUsd - this.spent - this.reservedUsd();
      const amount = Math.min(wantUsd, free);
      if (amount >= Math.min(MIN_STEP_USD, wantUsd)) {
        const id = this.nextId++;
        this.open.set(id, { amount, tag });
        return { ok: true, id, amountUsd: Math.round(amount * 1e4) / 1e4 };
      }
      if (this.open.size === 0) {
        return {
          ok: false,
          reason: `the shared cost cap of $${String(this.capUsd)} is reached ($${this.spent.toFixed(3)} spent)`,
        };
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Books the step's actual cost (unknown cost: the whole reservation counts). */
  settle(id: number, actualUsd: number | undefined): void {
    const reserved = this.open.get(id);
    if (reserved === undefined) return;
    this.open.delete(id);
    const cost = actualUsd ?? reserved.amount;
    this.spent += cost;
    if (reserved.tag !== null) this.byTag.set(reserved.tag, this.spentBy(reserved.tag) + cost);
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }
}
