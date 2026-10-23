import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { shouldInstallHooksForNodeAxiExecPath } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { axiError, usageError, type AxiError } from "../errors.js";
import {
  agentFiles,
  codexHooksEnabled,
  enableCodexHooks,
  findHooks,
  hookCommand,
  installHooks,
  openCodePlugin,
  pluginCommand,
  pluginState,
  readSettings,
  removeHooks,
  removePlugin,
  writeSettings,
  writeText,
  type HookKind,
  type PluginState,
  type Scope,
} from "../hooks.js";
import { block, helpBlock, out, shellQuote, type Obj } from "../render.js";
import { shellSegments } from "../sessionlog.js";

const NAME = "hetzner-axi";
const SKILL_INSTALL = `npx skills add cmosgh/${NAME} --skill ${NAME}`;

export const SETUP_HELP = `usage: hetzner-axi setup <hooks|status|uninstall> [--project | --local]
Opt-in agent hooks. At session start Claude Code, Codex and OpenCode run \`hetzner-axi context\` and add its short summary to the agent's context; it reads only the config file, never the Hetzner API or the keychain.
At session end Claude Code runs \`hetzner-axi context end\`, which records the hetzner-axi commands the session ran (names and counts, plus the HETZNER_AXI_CONTEXT used most; never other arguments) for the next session in the same directory.
flags{hooks,status,uninstall}:
  --project (this repository's shared config - .claude/settings.json, .codex/hooks.json, .opencode/plugins/ - instead of your user config), --local (this repository, only for you - Claude Code's .claude/settings.local.json)
notes:
  Rerun \`setup hooks\` after an upgrade or a move: it repairs the hook command, and is a no-op when nothing changed.
  Codex reads hooks only with [features] hooks = true in ~/.codex/config.toml: setup sets it; uninstall leaves it (other tools use it).
  Without hooks, install the skill instead (loads on demand, no per-session cost): ${SKILL_INSTALL}
examples[3]:
  hetzner-axi setup hooks
  hetzner-axi setup hooks --local
  hetzner-axi setup status --project
`;

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" } as const;
type Agent = keyof typeof AGENT_NAMES;

/** The hooks each agent gets: Codex and OpenCode have no session-end event with a transcript. */
const KINDS: Record<Agent, readonly HookKind[]> = { claude: ["start", "end"], codex: ["start"], opencode: ["start"] };

/** The installed binary running this command; a source checkout (tsx) is refused like the SDK does. */
function installedExecPath(): string | undefined {
  const execPath = resolve(process.argv[1] ?? "");
  return shouldInstallHooksForNodeAxiExecPath(execPath, { marker: NAME, binaryNames: [NAME], distEntrypoints: [`dist/bin/${NAME}.js`] }) ? execPath : undefined;
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** npx and pnpm dlx run from a cache that later sessions do not have on PATH, so a hook there breaks. */
const TEMPORARY_INSTALL = /[\\/](_npx|dlx)[\\/]/;

/** The bare name when PATH finds this same install (portable for teammates), else the absolute path. */
function portableBin(execPath: string): string {
  const target = real(execPath);
  const onPath = (process.env["PATH"] ?? "").split(delimiter).some((dir) => dir && target !== undefined && real(join(dir, NAME)) === target);
  return onPath ? NAME : execPath;
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** True when git would commit the file: inside a repository and not ignored. */
function committable(projectDir: string, file: string): boolean {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf-8" }).stdout?.trim() === "true";
  return inRepo && spawnSync("git", ["check-ignore", "-q", file], { cwd: projectDir }).status === 1;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const describeKinds = (kinds: readonly HookKind[]): string => (kinds.length === 2 ? "session start + end" : `session ${kinds[0]}`);

/** An absolute hook binary that no longer exists: hetzner-axi was moved or uninstalled. */
function missingBin(command: string): string | undefined {
  const bin = shellSegments(command)[0]?.[0];
  return bin && isAbsolute(bin) && !existsSync(bin) ? bin : undefined;
}

function agentStatus(agent: Agent, files: ReturnType<typeof agentFiles>): string {
  if (agent === "opencode") {
    let state: PluginState;
    try {
      state = pluginState(files.opencode!, NAME);
    } catch (error) {
      return `unreadable - ${messageOf(error)}`;
    }
    if (state === "missing") return "not installed";
    if (state === "foreign") return `not installed - ${tilde(files.opencode!)} was not written by setup`;
    const bin = pluginCommand(files.opencode!);
    if (bin && isAbsolute(bin) && !existsSync(bin)) return `broken - ${tilde(bin)} is missing; rerun setup hooks`;
    return state === "current" ? "session start" : "outdated - rerun setup hooks";
  }
  const path = agent === "claude" ? files.claude : files.codex!;
  let found: Partial<Record<HookKind, string>>;
  try {
    found = findHooks(readSettings(path), NAME);
  } catch (error) {
    return `unreadable - ${messageOf(error)}`;
  }
  const kinds = KINDS[agent].filter((kind) => found[kind] !== undefined);
  if (kinds.length === 0) return "not installed";
  const broken = kinds.map((kind) => missingBin(found[kind]!)).find(Boolean);
  if (broken) return `broken - ${tilde(broken)} is missing; rerun setup hooks`;
  const outdated = kinds.some((kind) => !found[kind]!.endsWith(hookCommand("", kind)));
  const missing = KINDS[agent].filter((kind) => found[kind] === undefined);
  if (outdated || missing.length > 0) return `${describeKinds(kinds)} - outdated; rerun setup hooks`;
  return describeKinds(kinds);
}

function status(scope: Scope): string {
  const files = agentFiles(NAME, scope, process.cwd());
  const hooks: Obj = { scope };
  for (const agent of Object.keys(AGENT_NAMES) as Agent[]) {
    if (agent !== "claude" && scope === "local") continue;
    hooks[agent === "claude" ? "claude_code" : agent] = agentStatus(agent, files);
  }
  if (files.codexConfig && hooks["codex"] !== "not installed" && !codexHooksEnabled(files.codexConfig)) {
    hooks["codex"] = `${String(hooks["codex"])} - but [features] hooks is off in ${tilde(files.codexConfig)}; rerun setup hooks`;
  }
  return block({ hooks });
}

interface Outcome {
  agent: Agent;
  result: string;
  failed?: string;
}

/** One agent's step: a failure is recorded and the other agents still run. */
function attempt(outcomes: Outcome[], agent: Agent, step: () => string): void {
  try {
    outcomes.push({ agent, result: step() });
  } catch (error) {
    outcomes.push({ agent, result: "failed", failed: messageOf(error) });
  }
}

function install(scope: Scope, bin: string): Outcome[] {
  const files = agentFiles(NAME, scope, process.cwd());
  const outcomes: Outcome[] = [];
  const settingsAgent = (agent: Agent, path: string, extra?: () => boolean): void =>
    attempt(outcomes, agent, () => {
      const [updated, changed] = installHooks(readSettings(path), NAME, shellQuote(bin), KINDS[agent]);
      if (changed) writeSettings(path, updated);
      const enabled = extra?.() ?? false;
      return changed || enabled ? `installed (${describeKinds(KINDS[agent])})` : "already up to date (no-op)";
    });
  settingsAgent("claude", files.claude);
  if (files.codex) settingsAgent("codex", files.codex, () => enableCodexHooks(files.codexConfig!));
  const plugin = files.opencode;
  if (plugin) {
    attempt(outcomes, "opencode", () => {
      const state = pluginState(plugin, NAME, bin);
      if (state === "foreign") throw new Error(`${plugin} exists and was not written by setup - remove or rename it`);
      if (state !== "current") writeText(plugin, openCodePlugin(NAME, bin));
      return state === "current" ? "already up to date (no-op)" : "installed (session start)";
    });
  }
  return outcomes;
}

function uninstall(scope: Scope): Outcome[] {
  const files = agentFiles(NAME, scope, process.cwd());
  const outcomes: Outcome[] = [];
  for (const [agent, path] of [["claude", files.claude], ["codex", files.codex]] as const) {
    if (!path) continue;
    attempt(outcomes, agent, () => {
      const [updated, changed] = removeHooks(readSettings(path), NAME);
      if (changed) writeSettings(path, updated);
      return changed ? "removed" : "not installed (no-op)";
    });
  }
  const plugin = files.opencode;
  if (plugin) {
    attempt(outcomes, "opencode", () => {
      const state = pluginState(plugin, NAME);
      if (state === "foreign") return `kept - ${tilde(plugin)} was not written by setup`;
      if (state === "missing") return "not installed (no-op)";
      removePlugin(plugin);
      return "removed";
    });
  }
  return outcomes;
}

/** SETUP_FAILED (exit 1) naming each failed agent and the ones that went through. */
function setupFailure(outcomes: Outcome[], rerun: string, kept: string): AxiError | undefined {
  const failed = outcomes.filter((o) => o.failed);
  if (failed.length === 0) return undefined;
  const done = outcomes.filter((o) => !o.failed).map((o) => AGENT_NAMES[o.agent]);
  return axiError(
    `${failed.map((o) => `${AGENT_NAMES[o.agent]} failed - ${o.failed}`).join("; ")}${done.length > 0 ? ` (${done.join(" and ")} done)` : ""}`,
    "SETUP_FAILED",
    [`Fix that, then rerun \`${rerun}\` - ${kept}`],
  );
}

const hooksBlock = (scope: Scope, outcomes: Outcome[]): Obj =>
  Object.fromEntries([["scope", scope], ...outcomes.map((o) => [o.agent === "claude" ? "claude_code" : o.agent, o.result])]);

export async function setupCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      "Run `hetzner-axi setup hooks` to install, `hetzner-axi setup status` to inspect, `hetzner-axi setup uninstall` to remove",
    ]);
  }
  const command = `hetzner-axi setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }, { name: "--local", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project | --local]`);
  if (bool(parsed, "--project") && bool(parsed, "--local")) throw usageError("pass --project or --local, not both");
  const scope: Scope = bool(parsed, "--local") ? "local" : bool(parsed, "--project") ? "project" : "user";
  const rerun = `${command}${scope === "user" ? "" : ` --${scope}`}`;

  if (sub === "status") return status(scope);
  if (sub === "uninstall") {
    const outcomes = uninstall(scope);
    const failure = setupFailure(outcomes, rerun, "hooks already removed stay removed");
    if (failure) throw failure;
    return block({ hooks: hooksBlock(scope, outcomes) });
  }

  const execPath = installedExecPath();
  if (!execPath) throw usageError(`run setup from an installed ${NAME} (npm install -g ${NAME}), not from a source checkout`);
  const temporary = TEMPORARY_INSTALL.exec(real(execPath) ?? execPath)?.[1];
  if (temporary) {
    throw usageError(`this ${NAME} runs from the ${temporary === "dlx" ? "pnpm dlx" : "npx"} cache, which later sessions do not have - a hook would break`, [
      `Run \`npm install -g ${NAME}\`, then \`${rerun}\``,
      `Or use the skill instead: ${SKILL_INSTALL}`,
    ]);
  }
  const bin = portableBin(execPath);
  const outcomes = install(scope, bin);
  const failure = setupFailure(outcomes, rerun, "hooks already in place are left as they are");
  if (failure) throw failure;
  const hooks = hooksBlock(scope, outcomes);
  hooks["runs"] = `${bin === NAME ? NAME : tilde(bin)} context`;
  const help: string[] = [];
  const localFile = join(".claude", "settings.local.json");
  if (scope === "local" && committable(process.cwd(), localFile)) help.push(`git would commit ${localFile} - add it to .gitignore to keep the hook personal`);
  if (scope === "project" && bin !== NAME) help.push(`The hooks run ${tilde(bin)}: teammates need hetzner-axi on PATH (npm install -g hetzner-axi), then rerun this from that install`);
  help.push("Restart the agent session to receive the hetzner-axi context");
  return out(block({ hooks }), helpBlock(help));
}
