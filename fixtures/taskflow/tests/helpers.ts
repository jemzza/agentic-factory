import type { FastifyInstance } from "fastify";
import { afterEach } from "vitest";
import { buildApp, type AppOptions } from "../src/app.js";
import type { TaskDto } from "../src/domain/task.js";

/** Deterministic clock: starts at a fixed instant and advances only when told to. */
export class FakeClock {
  private current: number;

  constructor(start = "2026-01-01T00:00:00.000Z") {
    this.current = Date.parse(start);
  }

  now = (): Date => new Date(this.current);

  advance(ms: number): void {
    this.current += ms;
  }
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

export interface TestContext {
  app: FastifyInstance;
  clock: FakeClock;
}

export function setup(options: Omit<AppOptions, "clock"> = {}): TestContext {
  const clock = new FakeClock();
  let seq = 0;
  const app = buildApp({
    generateId: () => `task-${++seq}`,
    ...options,
    clock: clock.now,
  });
  openApps.push(app);
  return { app, clock };
}

export async function createTask(
  app: FastifyInstance,
  body: Record<string, unknown> = { title: "Write docs" },
): Promise<TaskDto> {
  const res = await app.inject({ method: "POST", url: "/tasks", payload: body });
  if (res.statusCode !== 201) {
    throw new Error(`createTask failed: ${res.statusCode} ${res.body}`);
  }
  return res.json<TaskDto>();
}

export async function deleteTask(app: FastifyInstance, id: string): Promise<void> {
  const res = await app.inject({ method: "DELETE", url: `/tasks/${id}` });
  if (res.statusCode !== 204) {
    throw new Error(`deleteTask failed: ${res.statusCode} ${res.body}`);
  }
}
