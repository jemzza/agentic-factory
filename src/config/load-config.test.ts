import { describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "../paths.js";
import { assertOutside, expandHome, loadConfig } from "./load-config.js";

describe("config", () => {
  it("loads the committed factory.config.json", async () => {
    const config = await loadConfig(undefined, { FACTORY_WORKDIR: "/tmp/af-work" });
    expect(config.workdirAbs).toBe("/tmp/af-work");
    expect(config.target.checks.length).toBeGreaterThan(0);
  });

  it("expands ~", () => {
    expect(expandHome("~/w", "/home/u")).toBe("/home/u/w");
    expect(expandHome("/abs", "/home/u")).toBe("/abs");
  });

  it("refuses a workdir inside or containing the factory repo", () => {
    expect(() => {
      assertOutside(`${FACTORY_ROOT}/work`, FACTORY_ROOT);
    }).toThrow();
    expect(() => {
      assertOutside(FACTORY_ROOT, FACTORY_ROOT);
    }).toThrow();
    expect(() => {
      assertOutside("/", FACTORY_ROOT);
    }).toThrow();
    expect(() => {
      assertOutside("/tmp/af-work", FACTORY_ROOT);
    }).not.toThrow();
  });
});
