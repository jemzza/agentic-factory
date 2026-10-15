import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { AppError, toErrorBody } from "./errors.js";
import { InMemoryTaskRepository } from "./repository/in-memory-task-repository.js";
import type { TaskRepository } from "./repository/task-repository.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { TaskService } from "./services/task-service.js";

export interface AppOptions {
  /** Storage backend. Defaults to a fresh in-memory repository. */
  repository?: TaskRepository;
  /** Time source; inject a fake clock in tests. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Enable Fastify request logging. Defaults to `false`. */
  logger?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  const service = new TaskService({
    repository: options.repository ?? new InMemoryTaskRepository(),
    clock: options.clock ?? (() => new Date()),
    generateId: options.generateId ?? randomUUID,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(toErrorBody(error));
    }
    // Fastify's own client errors (malformed JSON, unsupported content type, ...).
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : "Bad request";
      return reply
        .code(400)
        .send(toErrorBody(new AppError("VALIDATION_ERROR", message)));
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply
      .code(500)
      .send(toErrorBody(new AppError("INTERNAL_ERROR", "Internal server error")));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(toErrorBody(new AppError("NOT_FOUND", `Route ${request.method} ${request.url} not found`))),
  );

  registerTaskRoutes(app, service);

  return app;
}
