// Shared harness for hidden acceptance tests.
// Copied next to the hidden tests into tests/__hidden__/ of a throwaway copy of the
// target repo. Depends only on the public API: buildApp({ clock, generateId }).
// Deliberately loosely typed so it type-checks against any reasonable implementation.
import type { FastifyInstance } from "fastify";
import { afterEach } from "vitest";
import { buildApp } from "../../src/app.js";

export const START = "2026-03-10T12:00:00.000Z";

export class Clock {
  private t: number;

  constructor(iso: string = START) {
    this.t = Date.parse(iso);
  }

  now = (): Date => new Date(this.t);

  advance(ms: number): void {
    this.t += ms;
  }

  iso(): string {
    return new Date(this.t).toISOString();
  }
}

export interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

export function setup(start: string = START) {
  const clock = new Clock(start);
  let n = 0;
  const app = buildApp({ clock: clock.now, generateId: () => `id-${++n}` });
  apps.push(app);

  async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown): Promise<Res> {
    const res = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    let body: unknown = null;
    if (res.body) {
      try {
        body = JSON.parse(res.body);
      } catch {
        body = res.body;
      }
    }
    return { status: res.statusCode, body };
  }

  const api = {
    app,
    clock,
    get: (url: string) => call("GET", url),
    post: (url: string, payload?: unknown) => call("POST", url, payload),
    patch: (url: string, payload: unknown) => call("PATCH", url, payload),
    del: (url: string) => call("DELETE", url),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async create(body: Record<string, unknown>): Promise<any> {
      const res = await call("POST", "/tasks", body);
      if (res.status !== 201) {
        throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body;
    },
    async remove(id: string): Promise<void> {
      const res = await call("DELETE", `/tasks/${id}`);
      if (res.status !== 204) {
        throw new Error(`delete failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
    },
  };
  return api;
}

export function errorCode(res: Res): unknown {
  return res.body?.error?.code;
}
