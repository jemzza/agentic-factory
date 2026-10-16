# TaskFlow — code conventions

TaskFlow is a task-tracking HTTP service: Fastify 5 + TypeScript (strict, ESM) + Zod,
with in-memory storage behind a repository interface.

## Before you finish

Run `npm run check` (typecheck + tests). Work is not done until it exits 0.

## Layout and layering

```
src/
  app.ts                  buildApp(options) — composition root, error/not-found handlers
  server.ts               process entry point (listen)
  errors.ts               AppError, error codes, error body format
  domain/task.ts          Task entity, TaskStatus, toTaskDto (Date → ISO string)
  repository/             TaskRepository interface + InMemoryTaskRepository
  services/task-service.ts  business rules (the only place rules live)
  routes/                 HTTP: Zod validation of params/query/body → service → DTO
tests/                    Vitest, black-box through app.inject()
```

- **Routes** parse input with `parseInput(schema, value)` and call the service. No business
  rules in routes.
- **Services** enforce rules and throw `AppError` (`notFound`, `conflict`, `validationError`).
  They depend on `TaskRepository`, `clock` and `generateId` — never on `Date.now()` or
  `randomUUID` directly.
- **Repositories** only store and filter; they return copies of entities.
- Relative imports use the `.js` extension. Use `import type` for type-only imports.

## Public API contract (do not break)

`buildApp(options?: { repository?, clock?, generateId?, logger? })` from `src/app.ts` is the
public entry point used by tests. Keep its signature backward compatible.

### HTTP

| Method | Path         | Success                     | Notes                                   |
| ------ | ------------ | --------------------------- | --------------------------------------- |
| POST   | `/tasks`     | 201 + task                  | body: `title`, `description?`, `status?` |
| GET    | `/tasks`     | 200 + `{ items: Task[] }`   | `?status=` filter; creation order       |
| GET    | `/tasks/:id` | 200 + task                  |                                         |
| PATCH  | `/tasks/:id` | 200 + task                  | partial update, at least one field      |
| DELETE | `/tasks/:id` | 204, empty body             | soft delete (sets `deletedAt`)          |

Task JSON: `{ id, title, description, status, createdAt, updatedAt, deletedAt }`;
dates are ISO-8601 strings, `deletedAt` is `null` for active tasks.
`status` is one of `todo | in_progress | done`.

### Errors

Every error response has the shape `{ "error": { "code", "message", "details?" } }`.

| Code               | HTTP | When                                                         |
| ------------------ | ---- | ------------------------------------------------------------ |
| `VALIDATION_ERROR` | 400  | invalid params/query/body, malformed JSON, unknown body keys |
| `NOT_FOUND`        | 404  | unknown id, unknown route, **reading** a soft-deleted task   |
| `CONFLICT`         | 409  | **mutating** a soft-deleted task; duplicate active title     |
| `INTERNAL_ERROR`   | 500  | unexpected errors                                            |

### Business rules

- Soft-deleted tasks are invisible to reads (`GET` → 404, excluded from lists) and cannot be
  modified (any mutation → 409 CONFLICT). Unknown ids → 404 NOT_FOUND.
- Every successful mutation sets `updatedAt` to `clock()`.
- `title` is trimmed, 1–200 chars, unique among active tasks (case-insensitive).
  `description` is at most 2000 chars, defaults to `""`. New tasks default to `todo`.
- Request bodies are strict: unknown keys → 400 VALIDATION_ERROR.

## Tests

- Test through HTTP with `app.inject()`; use `setup()`, `createTask()`, `deleteTask()` and
  `FakeClock` from `tests/helpers.ts`. Assert status code **and** error `code`.
- Every new endpoint or rule needs a success test and a test for each error path.
- Tests must be deterministic: advance the fake clock instead of sleeping.

## Do not

- Do not add dependencies or change `package.json`, `package-lock.json`, `tsconfig*.json`,
  or `vitest.config.ts`.
- Do not edit anything under `openspec/`: specifications are written and approved before
  implementation and are managed by the factory.
- Do not weaken, skip, or delete existing tests to make a change pass.
- Do not change existing behavior that a request does not explicitly ask to change. If a
  request contradicts the rules above, stop and ask instead of implementing it.
