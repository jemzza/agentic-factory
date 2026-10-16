import path from "node:path";
import type { ResolvedConfig } from "../config/load-config.js";
import { FACTORY_ROOT } from "../paths.js";
import { ClaudeCodeRuntime } from "./claude-code.js";
import { OpenCodeRuntime } from "./opencode.js";
import type { RoleBinding } from "../schemas/config.js";
import type { AgentRole, AgentRuntime } from "./types.js";

export const OPENCODE_BIN =
  process.env["OPENCODE_BIN"] ?? path.join(FACTORY_ROOT, "node_modules", ".bin", "opencode");

export function runtimeForBinding(
  binding: RoleBinding,
  logDir: string,
  claude: ClaudeCodeRuntime,
): AgentRuntime {
  switch (binding.runtime) {
    case "claude-code":
      return claude;
    case "opencode":
      return new OpenCodeRuntime({ bin: OPENCODE_BIN, keyEnv: binding.keyEnv, logDir });
  }
}

/** Builds one runtime per role from the config's role bindings (switching is config-only). */
export function buildRuntimes(
  config: ResolvedConfig,
  logDir: string,
): Record<AgentRole, AgentRuntime> {
  const claude = new ClaudeCodeRuntime({ logDir, models: config.models });
  const build = (role: AgentRole): AgentRuntime =>
    runtimeForBinding(config.roles[role], logDir, claude);
  return { planner: build("planner"), developer: build("developer"), reviewer: build("reviewer") };
}
