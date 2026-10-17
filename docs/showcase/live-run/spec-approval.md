# Spec approval needed — Завершение задачи (`complete-task`)

Run `20261016-062925-e708`, spec commit `f788965b3543d455d88f5bfb046d3d2a93962576`. Implementation starts only after approval.

```bash

npm run approve -- 20261016-062925-e708 spec

npm run reject -- 20261016-062925-e708 spec --comment "what to change"

```

## `openspec/changes/complete-task/proposal.md`

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

## `openspec/changes/complete-task/specs/task-completion/spec.md`

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

## `openspec/changes/complete-task/tasks.md`

```markdown
## 1. Implementation

- [ ] 1.1 Add TaskService.complete(id) using getMutable, setting status done and updatedAt from clock, and saving through the repository
- [ ] 1.2 Register POST /tasks/:id/complete in src/routes/tasks.ts, validating params with taskIdParamsSchema and returning toTaskDto with 200
- [ ] 1.3 Add tests/complete-task.test.ts: success (200, status done, updatedAt bumped, persisted), deleted task (409 CONFLICT), unknown id (404 NOT_FOUND)
- [ ] 1.4 Run npm run check and make sure it exits 0
```
