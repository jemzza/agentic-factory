import { describe, expect, it } from "vitest";
import { BOT_MARKER, isAllowed, parseCommand, specCommandApplies } from "./commands.js";

describe("parseCommand", () => {
  it("parses each command at the start of the first non-empty line", () => {
    expect(parseCommand("/approve")).toEqual({
      ok: true,
      command: { kind: "approve", hash: null },
    });
    expect(parseCommand("\n  \n/approve 0123456789ab")).toEqual({
      ok: true,
      command: { kind: "approve", hash: "0123456789ab" },
    });
    expect(parseCommand("/reject too vague\nalso cover X")).toEqual({
      ok: true,
      command: { kind: "reject", reason: "too vague\nalso cover X" },
    });
    expect(parseCommand("/merge")).toEqual({ ok: true, command: { kind: "merge" } });
    expect(parseCommand("/close not needed")).toEqual({
      ok: true,
      command: { kind: "close", reason: "not needed" },
    });
    expect(parseCommand("/retry")).toEqual({ ok: true, command: { kind: "retry" } });
  });

  it("is not a command anywhere but the start of the first line", () => {
    expect(parseCommand("Looks good, /approve")).toBeNull();
    expect(parseCommand("> /approve")).toBeNull();
    expect(parseCommand(" /approve")).toBeNull();
    expect(parseCommand("Thanks!\n/approve")).toBeNull();
    expect(parseCommand("/approved")).toBeNull();
    expect(parseCommand("/APPROVE")).toBeNull();
  });

  it("never treats a factory comment as a command, wherever the marker is", () => {
    expect(parseCommand(`${BOT_MARKER}\n/approve`)).toBeNull();
    expect(parseCommand(`/approve\n${BOT_MARKER}`)).toBeNull();
  });

  it("rejects malformed commands with a message", () => {
    expect(parseCommand("/reject")).toMatchObject({ ok: false });
    expect(parseCommand("/close")).toMatchObject({ ok: false });
    expect(parseCommand("/approve please")).toMatchObject({ ok: false });
    expect(parseCommand("/merge now")).toMatchObject({ ok: false });
  });
});

describe("isAllowed", () => {
  it("matches logins exactly, ignoring case", () => {
    expect(isAllowed("Owner", ["owner"])).toBe(true);
    expect(isAllowed("owner2", ["owner"])).toBe(false);
    expect(isAllowed("own", ["owner"])).toBe(false);
  });
});

describe("specCommandApplies", () => {
  const latest = { publishedAt: "2026-10-20T10:00:00Z", hash: "aaaaaaaaaaaa" };
  it("counts only for the latest version, written after it was published", () => {
    expect(specCommandApplies("2026-10-20T10:00:01Z", latest, null)).toEqual({ ok: true });
    expect(specCommandApplies("2026-10-20T10:00:01Z", latest, "aaaaaaaaaaaa")).toEqual({
      ok: true,
    });
    expect(specCommandApplies("2026-10-20T10:00:00Z", latest, null)).toMatchObject({ ok: false });
    expect(specCommandApplies("2026-10-20T10:00:01Z", latest, "bbbbbbbbbbbb")).toMatchObject({
      ok: false,
    });
  });
});
