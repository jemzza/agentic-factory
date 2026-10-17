# ✅ Завершение задачи — `success`

- **Run:** `20261016-062925-e708`
- **Task:** `complete-task`
- **Result:** gate passed and reviewer approved after 0 fix cycle(s)
- **Time:** 962.3s (limit 15 min)
- **Cost:** $0.636 of $1.000
- **Fix cycles:** 0 of 2
- **Runtime / models:** claude-code — planner: opus, developer: opus, reviewer: opus
- **Worktree:** `<FACTORY_WORKDIR>/worktrees/complete-task-20261016-062925-e708` (branch `factory/complete-task-20261016-062925-e708`, head `18703e7200`)
- **Base:** `c3ec3cd53d` in `<FACTORY_WORKDIR>/repos/taskflow-d2c25a5f7750`

> The change passed the sandboxed checks and an independent review. **A human must review and merge it.**

## Task

Добавь возможность завершать задачу. Нельзя завершать удалённую задачу.
Добавь тесты для успешного сценария и ошибок.

### Acceptance criteria

1. POST /tasks/:id/complete переводит задачу в статус done, обновляет updatedAt и возвращает 200 с обновлённой задачей
2. Для удалённой задачи возвращается 409 CONFLICT
3. Для несуществующей задачи возвращается 404 NOT_FOUND

## Plan

## Implementation plan

1. **Service** (`src/services/task-service.ts`): add `async complete(id: string): Promise<Task>`:
   - `const task = await this.getMutable(id);` (this gives 404 NOT_FOUND for an unknown id and 409 CONFLICT for a soft-deleted task, the same as the other mutations).
   - Build `updated = { ...task, status: "done", updatedAt: this.deps.clock() }`, call `repository.save(updated)`, and return `updated`.
   - Get the time from `this.deps.clock()`, never `Date.now()`.
2. **Route** (`src/routes/tasks.ts`): register `app.post("/tasks/:id/complete", ...)`:
   - `const { id } = parseInput(taskIdParamsSchema, request.params);`
   - `return toTaskDto(await service.complete(id));` (the default status is 200).
   - Do not validate the request body. The acceptance criteria do not mention it, so this change adds no body rule.
3. **Tests**: add a new file `tests/complete-task.test.ts` that uses `setup`, `createTask`, `deleteTask` and `FakeClock` from `tests/helpers.ts`, with `app.inject()` and no payload:
   - **Success**: create a task (status todo), call `clock.advance(5000)`, then POST `/tasks/:id/complete`. Expect 200 and `toEqual({ ...created, status: "done", updatedAt: "2026-01-01T00:00:05.000Z" })`. A follow-up GET `/tasks/:id` should return status `done`.
   - **Deleted task**: create the task, delete it, then POST complete. Expect 409 with `error.code === "CONFLICT"`.
   - **Unknown id**: POST `/tasks/nope/complete`. Expect 404 with `error.code === "NOT_FOUND"`.
4. Run `npm run check`. It must exit 0.

### Risks

- The request body is not in scope: the reviewer removed the strict-body requirement. Whether POST /tasks/:id/complete should reject a body with unknown keys (to match the strict-body convention for other endpoints) is still an open idea. It is not implemented here.
- Completing a task that is already done is not covered by the acceptance criteria. With the planned implementation it returns 200 and bumps updatedAt (idempotent). This behaviour is not specified, so it gets no test.
- If a test sends `content-type: application/json` with an empty payload, Fastify may reject it with 400. Tests should call inject without a payload.
- The route must reuse getMutable so that the 404/409 order stays consistent: check the unknown id first, then the deleted state.
- The test must advance the fake clock, otherwise it cannot show that updatedAt changed.

## Specification (OpenSpec `openspec/changes/complete-task`)

- **Approval:** manual
- **Validation:** valid after 1 attempt(s)
- **Spec commit:** `f788965b35`
- **Rejected by a human 1 time(s):** “Remove the 'Strict request body' requirement: it is not in the acceptance criteria. Do not add requirements beyond the acceptance criteria; list such ideas under risks or open questions instead.”

### `openspec/changes/complete-task/proposal.md`

```markdown
# Proposal

## Why

Clients cannot mark a task as finished with a single dedicated action. They have to send a generic PATCH. A complete endpoint makes finishing a task explicit and follows the soft-delete rules.

## What Changes

- New endpoint POST /tasks/:id/complete sets an active task's status to done, sets updatedAt to the current clock time, and returns 200 with the updated task.
- Completing a soft-deleted task returns 409 CONFLICT.
- Completing an unknown task id returns 404 NOT_FOUND.

## Capabilities

### New Capabilities

- `task-completion`: Lets clients mark an active task as done through a dedicated endpoint, following the soft-delete rules and error contract of the task service.

### Modified Capabilities

(none)

## Impact

src/services/task-service.ts (new TaskService.complete method), src/routes/tasks.ts (new POST /tasks/:id/complete route), tests/complete-task.test.ts (new). Existing endpoints and the buildApp signature do not change.
```

### `openspec/changes/complete-task/specs/task-completion/spec.md`

```markdown
## Purpose

Lets clients mark an active task as done through a dedicated endpoint, following the soft-delete rules and error contract of the task service.

## ADDED Requirements

### Requirement: Complete an active task

POST /tasks/:id/complete on an existing, non-deleted task SHALL set its status to done, set updatedAt to the current clock time, leave all other fields unchanged, and respond 200 with the updated task JSON.

#### Scenario: Complete a todo task

- **WHEN** an active task with status todo exists, the clock has advanced since it was created, and the client sends POST /tasks/:id/complete
- **THEN** the response is 200 with the task where status is done, updatedAt equals the current clock time, and id, title, description, createdAt and deletedAt (null) are unchanged; a later GET /tasks/:id returns status done

### Requirement: Reject completing a deleted task

POST /tasks/:id/complete on a soft-deleted task MUST respond 409 with error code CONFLICT.

#### Scenario: Deleted task

- **WHEN** the task has been soft-deleted and the client sends POST /tasks/:id/complete
- **THEN** the response is 409 with body { error: { code: "CONFLICT", message } }

### Requirement: Reject completing an unknown task

POST /tasks/:id/complete with an id that does not exist MUST respond 404 with error code NOT_FOUND.

#### Scenario: Unknown id

- **WHEN** the client sends POST /tasks/nope/complete and no task with id nope exists
- **THEN** the response is 404 with body { error: { code: "NOT_FOUND", message } }
```

### `openspec/changes/complete-task/tasks.md`

```markdown
## 1. Implementation

- [ ] 1.1 Add TaskService.complete(id) using getMutable, setting status done and updatedAt from clock, and saving through the repository
- [ ] 1.2 Register POST /tasks/:id/complete in src/routes/tasks.ts, validating params with taskIdParamsSchema and returning toTaskDto with 200
- [ ] 1.3 Add tests/complete-task.test.ts: success (200, status done, updatedAt bumped, persisted), deleted task (409 CONFLICT), unknown id (404 NOT_FOUND)
- [ ] 1.4 Run npm run check and make sure it exits 0
```

## Steps

| Cycle | Step          | Result       | Time  | Cost   | Tokens in/out | Denied tools | Details                      |
| ----- | ------------- | ------------ | ----- | ------ | ------------- | ------------ | ---------------------------- |
| 0     | planner       | ok           | 32.5s | $0.203 | 49636 / 3292  | 0            | `logs/01-planner-c0.jsonl`   |
| 0     | spec draft #1 | valid        |       |        |               |              | `231b0b4354`                 |
| 0     | planner       | ok           | 29.4s | $0.134 | 51510 / 3028  | 0            | `logs/02-planner-c0.jsonl`   |
| 0     | spec draft #1 | valid        |       |        |               |              | `f788965b35`                 |
| 0     | developer     | ok           | 25.4s | $0.154 | 62413 / 2056  | 0            | `logs/03-developer-c0.jsonl` |
| 0     | snapshot      | `18703e7200` |       |        |               |              |                              |
| 0     | gate          | passed       | 3.7s  |        |               |              | typecheck: ok, test: ok      |
| 0     | reviewer      | ok           | 11.8s | $0.147 | 39789 / 1100  | 0            | `logs/04-reviewer-c0.jsonl`  |

## Quality Gate (sandbox, `--network none`)

### Cycle 0: passed

**Scope:** ok — 3 changed file(s)

**`$ npm run typecheck`** → exit 0, 2.0s — full log: `<factory>/runs/20261016-062925-e708/checks/c0-typecheck.log`

```

> taskflow@1.0.0 typecheck
> tsc -p tsconfig.json --noEmit
```

**`$ npm test`** → exit 0, 1.6s — full log: `<factory>/runs/20261016-062925-e708/checks/c0-test.log`

```

> taskflow@1.0.0 test
> vitest run


 RUN  v5.0.4 /work

 ✓ tests/update-delete-task.test.ts (13 tests) 79ms
 ✓ tests/read-tasks.test.ts (9 tests) 74ms
 ✓ tests/create-task.test.ts (14 tests) 87ms
 ✓ tests/in-memory-task-repository.test.ts (3 tests) 4ms
 ✓ tests/complete-task.test.ts (3 tests) 58ms

 Test Files  5 passed (5)
      Tests  42 passed (42)
   Start at  06:45:14
   Duration  1.06s (import 44%, tests 41%, transform 13%, worker 2%)
```

## Review (final verdict: `approve`)

| #   | Criterion                                                                                                           | Met | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | POST /tasks/:id/complete переводит задачу в статус done, обновляет updatedAt и возвращает 200 с обновлённой задачей | ✅  | src/routes/tasks.ts:57-60 registers the route. It checks params with taskIdParamsSchema and returns toTaskDto with the default 200. TaskService.complete (src/services/task-service.ts:73-78) uses getMutable, sets status 'done' and updatedAt from deps.clock(), and saves through the repository. The test in tests/complete-task.test.ts moves the FakeClock forward by 5s and checks the full body: the original fields stay the same, status is done, and updatedAt is 00:00:05. A follow-up GET confirms the change was saved. |
| 2   | Для удалённой задачи возвращается 409 CONFLICT                                                                      | ✅  | getMutable throws conflict() for soft-deleted tasks (task-service.ts:90). The test 'returns 409 CONFLICT for a soft-deleted task' checks both the 409 status and the CONFLICT error code.                                                                                                                                                                                                                                                                                                                                             |
| 3   | Для несуществующей задачи возвращается 404 NOT_FOUND                                                                | ✅  | getMutable throws notFound() when the task is missing (task-service.ts:89). The test 'returns 404 NOT_FOUND for an unknown id' sends POST /tasks/nope/complete and checks both the 404 status and the NOT_FOUND error code.                                                                                                                                                                                                                                                                                                           |

### Issues

- **minor** `src/routes/tasks.ts`: The complete endpoint ignores any request body, so it does not reject unknown keys the way other mutating routes do. The spec defines no body, so this is fine. If you want strictness to match the other routes, you could validate an optional empty strictObject.

## Diff

- `openspec/changes/complete-task/.openspec.yaml`
- `openspec/changes/complete-task/proposal.md`
- `openspec/changes/complete-task/specs/task-completion/spec.md`
- `openspec/changes/complete-task/tasks.md`
- `src/routes/tasks.ts`
- `src/services/task-service.ts`
- `tests/complete-task.test.ts`

```diff
diff --git a/openspec/changes/complete-task/.openspec.yaml b/openspec/changes/complete-task/.openspec.yaml
new file mode 100644
index 0000000..0cb4765
--- /dev/null
+++ b/openspec/changes/complete-task/.openspec.yaml
@@ -0,0 +1,2 @@
+schema: spec-driven
+created: 2026-10-16
diff --git a/openspec/changes/complete-task/proposal.md b/openspec/changes/complete-task/proposal.md
new file mode 100644
index 0000000..600713a
--- /dev/null
+++ b/openspec/changes/complete-task/proposal.md
@@ -0,0 +1,25 @@
+# Proposal
+
+## Why
+
+Clients cannot mark a task as finished with a single dedicated action. They have to send a generic PATCH. A complete endpoint makes finishing a task explicit and follows the soft-delete rules.
+
+## What Changes
+
+- New endpoint POST /tasks/:id/complete sets an active task's status to done, sets updatedAt to the current clock time, and returns 200 with the updated task.
+- Completing a soft-deleted task returns 409 CONFLICT.
+- Completing an unknown task id returns 404 NOT_FOUND.
+
+## Capabilities
+
+### New Capabilities
+
+- `task-completion`: Lets clients mark an active task as done through a dedicated endpoint, following the soft-delete rules and error contract of the task service.
+
+### Modified Capabilities
+
+(none)
+
+## Impact
+
+src/services/task-service.ts (new TaskService.complete method), src/routes/tasks.ts (new POST /tasks/:id/complete route), tests/complete-task.test.ts (new). Existing endpoints and the buildApp signature do not change.
diff --git a/openspec/changes/complete-task/specs/task-completion/spec.md b/openspec/changes/complete-task/specs/task-completion/spec.md
new file mode 100644
index 0000000..f8e1d31
--- /dev/null
+++ b/openspec/changes/complete-task/specs/task-completion/spec.md
@@ -0,0 +1,26 @@
+## Purpose
+
+Lets clients mark an active task as done through a dedicated endpoint, following the soft-delete rules and error contract of the task service.
+
+## ADDED Requirements
+
+### Requirement: Complete an active task
+POST /tasks/:id/complete on an existing, non-deleted task SHALL set its status to done, set updatedAt to the current clock time, leave all other fields unchanged, and respond 200 with the updated task JSON.
+
+#### Scenario: Complete a todo task
+- **WHEN** an active task with status todo exists, the clock has advanced since it was created, and the client sends POST /tasks/:id/complete
+- **THEN** the response is 200 with the task where status is done, updatedAt equals the current clock time, and id, title, description, createdAt and deletedAt (null) are unchanged; a later GET /tasks/:id returns status done
+
+### Requirement: Reject completing a deleted task
+POST /tasks/:id/complete on a soft-deleted task MUST respond 409 with error code CONFLICT.
+
+#### Scenario: Deleted task
+- **WHEN** the task has been soft-deleted and the client sends POST /tasks/:id/complete
+- **THEN** the response is 409 with body { error: { code: "CONFLICT", message } }
+
+### Requirement: Reject completing an unknown task
+POST /tasks/:id/complete with an id that does not exist MUST respond 404 with error code NOT_FOUND.
+
+#### Scenario: Unknown id
+- **WHEN** the client sends POST /tasks/nope/complete and no task with id nope exists
+- **THEN** the response is 404 with body { error: { code: "NOT_FOUND", message } }
diff --git a/openspec/changes/complete-task/tasks.md b/openspec/changes/complete-task/tasks.md
new file mode 100644
index 0000000..253ea99
--- /dev/null
+++ b/openspec/changes/complete-task/tasks.md
@@ -0,0 +1,6 @@
+## 1. Implementation
+
+- [ ] 1.1 Add TaskService.complete(id) using getMutable, setting status done and updatedAt from clock, and saving through the repository
+- [ ] 1.2 Register POST /tasks/:id/complete in src/routes/tasks.ts, validating params with taskIdParamsSchema and returning toTaskDto with 200
+- [ ] 1.3 Add tests/complete-task.test.ts: success (200, status done, updatedAt bumped, persisted), deleted task (409 CONFLICT), unknown id (404 NOT_FOUND)
+- [ ] 1.4 Run npm run check and make sure it exits 0
diff --git a/src/routes/tasks.ts b/src/routes/tasks.ts
index 6dcf307..9ccdd6a 100644
--- a/src/routes/tasks.ts
+++ b/src/routes/tasks.ts
@@ -54,6 +54,11 @@ export function registerTaskRoutes(app: FastifyInstance, service: TaskService):
     return toTaskDto(await service.update(id, body));
   });

+  app.post("/tasks/:id/complete", async (request) => {
+    const { id } = parseInput(taskIdParamsSchema, request.params);
+    return toTaskDto(await service.complete(id));
+  });
+
   app.delete("/tasks/:id", async (request, reply) => {
     const { id } = parseInput(taskIdParamsSchema, request.params);
     await service.softDelete(id);
diff --git a/src/services/task-service.ts b/src/services/task-service.ts
index 5faae72..b4e462a 100644
--- a/src/services/task-service.ts
+++ b/src/services/task-service.ts
@@ -70,6 +70,13 @@ export class TaskService {
     return updated;
   }

+  async complete(id: string): Promise<Task> {
+    const task = await this.getMutable(id);
+    const updated: Task = { ...task, status: "done", updatedAt: this.deps.clock() };
+    await this.deps.repository.save(updated);
+    return updated;
+  }
+
   async softDelete(id: string): Promise<void> {
     const task = await this.getMutable(id);
     const now = this.deps.clock();
diff --git a/tests/complete-task.test.ts b/tests/complete-task.test.ts
new file mode 100644
index 0000000..1540372
--- /dev/null
+++ b/tests/complete-task.test.ts
@@ -0,0 +1,44 @@
+import { describe, expect, it } from "vitest";
+import { createTask, deleteTask, setup } from "./helpers.js";
+
+describe("POST /tasks/:id/complete", () => {
+  it("marks an active task as done and bumps updatedAt", async () => {
+    const { app, clock } = setup();
+    const created = await createTask(app);
+    expect(created.status).toBe("todo");
+    clock.advance(5000);
+
+    const res = await app.inject({ method: "POST", url: `/tasks/${created.id}/complete` });
+
+    expect(res.statusCode).toBe(200);
+    expect(res.json()).toEqual({
+      ...created,
+      status: "done",
+      updatedAt: "2026-01-01T00:00:05.000Z",
+    });
+
+    const fetched = await app.inject({ method: "GET", url: `/tasks/${created.id}` });
+    expect(fetched.statusCode).toBe(200);
+    expect(fetched.json().status).toBe("done");
+  });
+
+  it("returns 409 CONFLICT for a soft-deleted task", async () => {
+    const { app } = setup();
+    const created = await createTask(app);
+    await deleteTask(app, created.id);
+
+    const res = await app.inject({ method: "POST", url: `/tasks/${created.id}/complete` });
+
+    expect(res.statusCode).toBe(409);
+    expect(res.json().error.code).toBe("CONFLICT");
+  });
+
+  it("returns 404 NOT_FOUND for an unknown id", async () => {
+    const { app } = setup();
+
+    const res = await app.inject({ method: "POST", url: "/tasks/nope/complete" });
+
+    expect(res.statusCode).toBe(404);
+    expect(res.json().error.code).toBe("NOT_FOUND");
+  });
+});
```
