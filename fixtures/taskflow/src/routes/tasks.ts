import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { toTaskDto } from "../domain/task.js";
import type { TaskService } from "../services/task-service.js";
import {
  descriptionSchema,
  parseInput,
  taskIdParamsSchema,
  taskStatusSchema,
  titleSchema,
} from "./validation.js";

const createTaskBodySchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema.optional(),
  status: taskStatusSchema.optional(),
});

const updateTaskBodySchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    status: taskStatusSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
});

export function registerTaskRoutes(app: FastifyInstance, service: TaskService): void {
  app.post("/tasks", async (request, reply) => {
    const body = parseInput(createTaskBodySchema, request.body);
    const task = await service.create(body);
    return reply.code(201).send(toTaskDto(task));
  });

  app.get("/tasks", async (request) => {
    const query = parseInput(listTasksQuerySchema, request.query);
    const tasks = await service.list(query);
    return { items: tasks.map(toTaskDto) };
  });

  app.get("/tasks/:id", async (request) => {
    const { id } = parseInput(taskIdParamsSchema, request.params);
    return toTaskDto(await service.get(id));
  });

  app.patch("/tasks/:id", async (request) => {
    const { id } = parseInput(taskIdParamsSchema, request.params);
    const body = parseInput(updateTaskBodySchema, request.body);
    return toTaskDto(await service.update(id, body));
  });

  app.delete("/tasks/:id", async (request, reply) => {
    const { id } = parseInput(taskIdParamsSchema, request.params);
    await service.softDelete(id);
    return reply.code(204).send();
  });
}
