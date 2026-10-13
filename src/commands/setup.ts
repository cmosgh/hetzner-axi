import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";

export const SETUP_HELP = `usage: hetzner-axi setup <hooks|status|uninstall> [--project]
Manage the opt-in SessionStart integration that shows your Hetzner Cloud servers (hetzner-axi home view) to Claude Code, Codex and OpenCode at session start.
flags:
  --project (install into the current repository's agent config instead of your user config)
notes:
  User scope runs in every session; until hetzner-axi is configured the home view is two lines and makes no network calls.
examples[3]:
  hetzner-axi setup hooks
  hetzner-axi setup hooks --project
  hetzner-axi setup status
`;

const IDENTITY = { marker: "hetzner-axi", binaryNames: ["hetzner-axi"] };

export async function setupCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      "Run `hetzner-axi setup hooks` to install, `hetzner-axi setup status` to inspect, `hetzner-axi setup uninstall` to remove",
    ]);
  }
  const command = `hetzner-axi setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project]`);
  const scope = bool(parsed, "--project") ? "project" : "user";

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...IDENTITY, scope });
    return block({
      hooks: {
        scope,
        claude_code: status.claude.installed ? "installed" : "not installed",
        codex: status.codex.installed ? "installed" : "not installed",
        opencode: status.opencode.installed ? "installed" : "not installed",
      },
    });
  }

  if (sub === "uninstall") {
    await uninstallSessionStartHooks({ ...IDENTITY, scope });
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }

  await installSessionStartHooks({ ...IDENTITY, scope });
  return out(
    block({ hooks: { scope, status: "installed or already up to date", integrations: "Claude Code, Codex, OpenCode" } }),
    helpBlock(["Restart the agent session to receive the hetzner-axi home view as ambient context"]),
  );
}
