import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./_harness.js";

describe("hidden: star-task", () => {
  it("has starred=false by default everywhere; star and unstar toggle it and bump updatedAt", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    expect(task.starred).toBe(false);
    expect((await api.get(`/tasks`)).body.items[0].starred).toBe(false);
    api.clock.advance(1000);
    const starred = await api.post(`/tasks/${task.id}/star`);
    expect(starred.status).toBe(200);
    expect(starred.body).toMatchObject({ starred: true, updatedAt: api.clock.iso() });
    api.clock.advance(1000);
    const unstarred = await api.post(`/tasks/${task.id}/unstar`);
    expect(unstarred.body).toMatchObject({ starred: false, updatedAt: api.clock.iso() });
  });

  it("is 409 for a deleted task and 404 for an unknown one", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    await api.remove(task.id);
    expect(errorCode(await api.post(`/tasks/${task.id}/star`))).toBe("CONFLICT");
    expect(errorCode(await api.post(`/tasks/nope/unstar`))).toBe("NOT_FOUND");
  });

  it("[lesson] starring a starred task (or unstarring an unstarred one) is a no-op: 200, updatedAt unchanged", async () => {
    const api = setup();
    const task = await api.create({ title: "A" });
    api.clock.advance(1000);
    const first = await api.post(`/tasks/${task.id}/star`);
    api.clock.advance(1000);
    const again = await api.post(`/tasks/${task.id}/star`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    api.clock.advance(1000);
    const other = await api.create({ title: "B" });
    const noop = await api.post(`/tasks/${other.id}/unstar`);
    expect(noop.status).toBe(200);
    expect(noop.body.updatedAt).toBe(other.updatedAt);
  });
});
