import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: duplicate-task", () => {
  it("creates a copy with the title suffix, same description, status todo", async () => {
    const api = setup();
    const task = await api.create({ title: "Ship", description: "v1", status: "done" });
    const res = await api.post(`/tasks/${task.id}/duplicate`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Ship (copy)", description: "v1", status: "todo", deletedAt: null });
    expect(res.body.id).not.toBe(task.id);
    expect((await api.get(`/tasks`)).body.items).toHaveLength(2);
  });

  it("is 409 when the copy's title is taken, 409 for a deleted task, 404 for an unknown one", async () => {
    const api = setup();
    const task = await api.create({ title: "Ship" });
    await api.create({ title: "ship (COPY)" });
    expect(errorCode(await api.post(`/tasks/${task.id}/duplicate`))).toBe("CONFLICT");
    const gone = await api.create({ title: "Gone" });
    await api.remove(gone.id);
    expect(errorCode(await api.post(`/tasks/${gone.id}/duplicate`))).toBe("CONFLICT");
    expect(errorCode(await api.post(`/tasks/nope/duplicate`))).toBe("NOT_FOUND");
  });

  it("[lesson] rejects any request body field with 400 VALIDATION_ERROR and creates nothing", async () => {
    const api = setup();
    const task = await api.create({ title: "Ship" });
    const res = await api.post(`/tasks/${task.id}/duplicate`, { title: "Other" });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
    expect((await api.get(`/tasks`)).body.items).toHaveLength(1);
  });
});
