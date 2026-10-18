/**
 * Detects that the host was suspended (laptop lid closed, system sleep). A suspended machine
 * freezes this process: no timers run, no child makes progress, and the network is gone after
 * wake. A step that times out or fails across such a gap says nothing about the agent or the
 * factory, so it is classified as `infra` (see provider-errors.ts), like a provider outage.
 *
 * Detection does not depend on which clock Node's timers use: an interval ticks every
 * `intervalMs`; a tick that arrives more than `gapMs` after the previous one means the event
 * loop was frozen for that long. Observed 2026-10-18: lid closed on battery during an eval
 * step; the step's 15-minute timeout fired 96 minutes later, on wake (pmset: "Clamshell Sleep"
 * 06:06:14, "DarkWake" 07:42:05).
 */
export interface Suspension {
  fromMs: number;
  toMs: number;
}

export class SuspendMonitor {
  private last: number;
  private timer: NodeJS.Timeout | null = null;
  readonly suspensions: Suspension[] = [];

  constructor(
    private readonly opts: { intervalMs: number; gapMs: number; now: () => number } = {
      intervalMs: 5_000,
      gapMs: 30_000,
      now: Date.now,
    },
  ) {
    this.last = opts.now();
  }

  /** Starts ticking (idempotent). The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.last = this.opts.now();
    this.timer = setInterval(() => {
      this.tick();
    }, this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Records a gap since the previous tick, if any. Also call it before reading results. */
  tick(): void {
    const now = this.opts.now();
    if (now - this.last > this.opts.gapMs) this.record({ fromMs: this.last, toMs: now });
    this.last = now;
  }

  record(s: Suspension): void {
    this.suspensions.push(s);
  }

  /** Milliseconds of suspension that overlap [fromMs, toMs] (wall clock). */
  suspendedWithin(fromMs: number, toMs: number): number {
    this.tick();
    return this.suspensions.reduce(
      (sum, s) => sum + Math.max(0, Math.min(s.toMs, toMs) - Math.max(s.fromMs, fromMs)),
      0,
    );
  }
}

/** The process-wide monitor; started on first import. */
export const hostSuspend = new SuspendMonitor();
hostSuspend.start();
