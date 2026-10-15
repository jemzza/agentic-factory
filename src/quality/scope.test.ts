import { describe, expect, it } from "vitest";
import { checkScope, globToRegExp } from "./scope.js";

describe("globToRegExp", () => {
  it.each([
    ["src/**", "src/a.ts", true],
    ["src/**", "src/deep/nested/a.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["src/**", "package.json", false],
    ["tests/**/*.test.ts", "tests/a.test.ts", true],
    ["tests/**/*.test.ts", "tests/x/y/a.test.ts", true],
    ["tests/**/*.test.ts", "tests/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["a.b", "axb", false],
  ])("%s matches %s → %s", (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });
});

describe("checkScope", () => {
  it("passes when every change is inside allowed paths", () => {
    expect(checkScope(["src/a.ts", "tests/a.test.ts"], ["src/**", "tests/**"])).toMatchObject({
      passed: true,
      violations: [],
    });
  });

  it("reports files outside allowed paths", () => {
    expect(checkScope(["src/a.ts", "package.json", "../x"], ["src/**"])).toMatchObject({
      passed: false,
      violations: ["package.json", "../x"],
    });
  });

  it("fails on an empty change set", () => {
    expect(checkScope([], ["src/**"])).toMatchObject({ passed: false, empty: true });
  });
});
