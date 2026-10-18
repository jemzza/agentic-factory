import { describe, expect, it, vi } from "vitest";
import { checkOpenAI } from "./provider-check.js";

const answer = (status: number) =>
  vi.fn(() => Promise.resolve(new Response("{}", { status }))) as unknown as typeof fetch;

describe("provider:check openai", () => {
  it("without the key: a clear message, exit 2, and nothing is called", async () => {
    const f = answer(200);
    const r = await checkOpenAI({}, f);
    expect(r.exitCode).toBe(2);
    expect(r.lines[0]?.detail).toMatch(/OPENAI_API_KEY is not set.*docs\/enable-openai\.md/);
    expect(f).not.toHaveBeenCalled();
  });

  it("classifies the answer: accepted, rejected key, unavailable provider", async () => {
    const env = { OPENAI_API_KEY: "sk-test-0123456789" };
    expect((await checkOpenAI(env, answer(200))).exitCode).toBe(0);
    expect((await checkOpenAI(env, answer(401))).exitCode).toBe(1);
    expect((await checkOpenAI(env, answer(429))).exitCode).toBe(3);
    expect((await checkOpenAI(env, answer(503))).exitCode).toBe(3);
    const down = vi.fn(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as unknown as typeof fetch;
    expect((await checkOpenAI(env, down)).exitCode).toBe(3);
    const ok = await checkOpenAI(env, answer(200));
    expect(JSON.stringify(ok)).not.toContain("sk-test-0123456789");
  });
});
