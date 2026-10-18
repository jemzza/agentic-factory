import { describe, expect, it } from "vitest";
import { SuspendMonitor } from "./host-suspend.js";

function monitor() {
  let t = 1_000_000;
  const m = new SuspendMonitor({ intervalMs: 5_000, gapMs: 30_000, now: () => t });
  return { m, advance: (ms: number) => (t += ms), at: () => t };
}

describe("SuspendMonitor", () => {
  it("records a frozen event loop (a tick gap above gapMs) as a suspension", () => {
    const { m, advance, at } = monitor();
    advance(5_000);
    m.tick();
    advance(5_000);
    m.tick();
    expect(m.suspensions).toEqual([]);
    const before = at();
    advance(96 * 60_000); // lid closed for 96 minutes
    m.tick();
    expect(m.suspensions).toEqual([{ fromMs: before, toMs: at() }]);
  });

  it("measures only the part of a suspension that overlaps the interval", () => {
    const { m } = monitor();
    m.record({ fromMs: 100, toMs: 200 });
    m.record({ fromMs: 500, toMs: 900 });
    expect(m.suspendedWithin(0, 1_000)).toBe(500);
    expect(m.suspendedWithin(150, 600)).toBe(150);
    expect(m.suspendedWithin(200, 500)).toBe(0);
  });

  it("does not count a gap that is within the tolerance", () => {
    const { m, advance } = monitor();
    advance(25_000);
    m.tick();
    expect(m.suspensions).toEqual([]);
  });
});
