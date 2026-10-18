import path from "node:path";
import type { ResolvedConfig } from "../config/load-config.js";
import { FACTORY_ROOT } from "../paths.js";
import { ClaudeCodeRuntime } from "./claude-code.js";
import { OpenCodeRuntime } from "./opencode.js";
import { PiRuntime } from "./pi.js";
import type { RoleBinding } from "../schemas/config.js";
import type { AgentRole, AgentRuntime } from "./types.js";

export const OPENCODE_BIN =
  process.env["OPENCODE_BIN"] ?? path.join(FACTORY_ROOT, "node_modules", ".bin", "opencode");

export const PI_BIN =
  process.env["PI_BIN"] ?? path.join(FACTORY_ROOT, "node_modules", ".bin", "pi");
/** The factory's Pi extension that confines tool calls to the worktree. */
export const PI_GUARD = path.join(FACTORY_ROOT, "src", "runtimes", "pi-guard.ts");
/** Factory-owned Pi agent dir (models.json, auth.json): under the workdir, outside every worktree. */
export const piAgentDir = (workdirAbs: string) => path.join(workdirAbs, "pi-agent");

export function runtimeForBinding(
  binding: RoleBinding,
  logDir: string,
  claude: ClaudeCodeRuntime,
  workdirAbs: string,
): AgentRuntime {
  switch (binding.runtime) {
    case "claude-code":
      return claude;
    case "opencode":
      return new OpenCodeRuntime({ bin: OPENCODE_BIN, keyEnv: binding.keyEnv, logDir });
    case "pi":
      return new PiRuntime({
        bin: PI_BIN,
        guardPath: PI_GUARD,
        agentDir: piAgentDir(workdirAbs),
        keyEnv: binding.keyEnv,
        logDir,
      });
  }
}

/** Builds one runtime per role from the config's role bindings (switching is config-only). */
export function buildRuntimes(
  config: ResolvedConfig,
  logDir: string,
): Record<AgentRole, AgentRuntime> {
  const claude = new ClaudeCodeRuntime({ logDir, models: config.models });
  const build = (role: AgentRole): AgentRuntime =>
    runtimeForBinding(config.roles[role], logDir, claude, config.workdirAbs);
  return { planner: build("planner"), developer: build("developer"), reviewer: build("reviewer") };
}
