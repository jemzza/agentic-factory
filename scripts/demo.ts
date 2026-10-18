// Demo sandbox (docs/demo.md). Never touches the working data/factory.db, runs/ or workdir.
//   npm run demo:reset [-- --owner <github-login>]   wipe and recreate ~/agentic-factory-demo
//   npm run demo -- <factory command> [args...]      run a factory command in the sandbox,
//                                                    e.g. `npm run demo -- watch`, `-- dashboard`
// FACTORY_DEMO_ROOT moves the sandbox elsewhere (outside the repo and the working workdir).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { loadConfig } from "../src/config/load-config.js";
import { DEFAULT_DEMO_ROOT, demoPaths, resetDemo } from "../src/demo/demo-env.js";
import { FACTORY_ROOT } from "../src/paths.js";

const root = process.env["FACTORY_DEMO_ROOT"] ?? DEFAULT_DEMO_ROOT;
const [mode, ...rest] = process.argv.slice(2);

if (mode === "reset") {
  const i = rest.indexOf("--owner");
  const owner = i >= 0 ? (rest[i + 1] ?? null) : (process.env["FACTORY_DEMO_GITHUB_OWNER"] ?? null);
  // The working workdir: .env and the shell as the factory reads them, minus a demo override.
  let dotenv: Record<string, string> = {};
  try {
    dotenv = parseEnv(await readFile(path.join(FACTORY_ROOT, ".env"), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    // no .env
  }
  const workingEnv: NodeJS.ProcessEnv = { ...process.env, ...dotenv };
  if (path.resolve(workingEnv["FACTORY_WORKDIR"] ?? "/") === demoPaths(root).workdir)
    delete workingEnv["FACTORY_WORKDIR"];
  const working = await loadConfig(undefined, workingEnv);
  const p = await resetDemo(root, {
    owner,
    factoryRoot: FACTORY_ROOT,
    workdir: working.workdirAbs,
    home: os.homedir(),
  });
  console.log(`Demo sandbox ready: ${p.root}`);
  console.log(
    `  database ${p.db}\n  workdir  ${p.workdir}\n  runs     ${p.runs}\n  projects ${p.registry}`,
  );
  if (owner === null) {
    console.log(
      "No --owner: the registry has the fixture projects only (never a real repository); the GitHub steps of docs/demo.md need `npm run demo:reset -- --owner <login>`.",
    );
  }
  console.log("Next: npm run demo -- watch   (and npm run demo -- dashboard in another terminal)");
} else if (mode === "run") {
  const p = demoPaths(root);
  let text: string;
  try {
    text = await readFile(p.envFile, "utf8");
  } catch {
    console.error(`No demo sandbox at ${p.root}: run npm run demo:reset first`);
    process.exit(2);
  }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
  }
  if (rest.length === 0) {
    console.error("usage: npm run demo -- <factory command> [args...]");
    process.exit(2);
  }
  const child = spawn(
    path.join(FACTORY_ROOT, "node_modules", ".bin", "tsx"),
    [path.join(FACTORY_ROOT, "src", "cli.ts"), ...rest],
    { stdio: "inherit", env: { ...process.env, ...env } },
  );
  // Ctrl+C reaches the child through the terminal; the wrapper only waits for it.
  process.on("SIGINT", () => undefined);
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 130 : 1));
  });
} else {
  console.error("usage: tsx scripts/demo.ts reset [--owner <login>] | run <command> [args...]");
  process.exit(2);
}
