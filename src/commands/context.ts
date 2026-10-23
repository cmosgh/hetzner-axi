import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import { expectPositionals, parseArgs } from "../args.js";
import { readConfig } from "../config.js";
import { LOGIN_HINT } from "../credentials.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import { lastSession, recordSession, sessionText, summarizeTranscript, type CommandLookup } from "../sessionlog.js";

export const CONTEXT_HELP = `usage: hetzner-axi context [end]
What the session-start hook prints: the stored contexts, whether HCLOUD_TOKEN is set and what the last session in this directory ran. It reads only the config file - never the Hetzner API or the keychain - and exits 0.
\`context end\` is the Claude Code session-end hook: it reads the hook payload on stdin and records the hetzner-axi commands the session ran (names and counts, never arguments).
examples[2]:
  hetzner-axi context
  hetzner-axi setup hooks
`;

export interface ContextOptions {
  description: string;
  commandName: CommandLookup;
}

/** Sessions are keyed by directory; realpath so a symlinked checkout matches itself. */
function directoryKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** The stored contexts as commands will see them: the active one, or the one HETZNER_AXI_CONTEXT selects. */
function contextList(contexts: readonly string[], active: string | undefined, selected: string | undefined): string {
  const marked = contexts.map((c) => (c === selected ? `${c} (HETZNER_AXI_CONTEXT)` : c === active && !selected ? `${c} (active)` : c));
  if (selected && !contexts.includes(selected)) marked.push(`${selected} (HETZNER_AXI_CONTEXT - not logged in)`);
  return marked.join("; ");
}

function view(options: ContextOptions): string {
  const config = readConfig();
  const contexts = config.contexts ?? [];
  const selected = process.env["HETZNER_AXI_CONTEXT"] || undefined;
  const tokenSet = Boolean(process.env["HCLOUD_TOKEN"]);
  const last = lastSession(directoryKey(process.cwd()));
  const header = block({ bin: tilde(process.argv[1] ?? "hetzner-axi"), description: options.description });
  const lastRun = last && block({ last_session: sessionText(last) });
  if (!tokenSet && contexts.length === 0) {
    return out(header, block({ hetzner: "not configured" }), lastRun, helpBlock([LOGIN_HINT, "Or set HCLOUD_TOKEN in the environment"]));
  }
  const help = [
    "Run `hetzner-axi` for live server state; `hetzner-axi --help` for commands",
    "Run `hetzner-axi server list`, `hetzner-axi firewall list` or `hetzner-axi dns zone list` to explore; `hetzner-axi <command> --help` for flags",
  ];
  if (!tokenSet && contexts.length > 1) help.push(`Switch projects with \`hetzner-axi auth use <${contexts.join("|")}>\`, or prefix one command with \`HETZNER_AXI_CONTEXT=<name>\``);
  return out(
    header,
    block({
      contexts: contextList(contexts, config.active, selected) || "none",
      hcloud_token: tokenSet ? "set - commands use it instead of the stored contexts" : "not set",
    }),
    lastRun,
    helpBlock(help),
  );
}

/** Never fails the agent's exit: a payload it cannot use records nothing. */
async function end(commandName: CommandLookup): Promise<string> {
  if (process.stdin.isTTY) throw usageError("context end reads a session-end hook payload on stdin", ["It runs from the hook `hetzner-axi setup hooks` installs"]);
  let payload: { transcript_path?: unknown; cwd?: unknown } | null;
  try {
    payload = JSON.parse(readFileSync(0, "utf-8")) as typeof payload;
  } catch {
    return block({ recorded: "nothing - stdin is not a hook payload" });
  }
  if (typeof payload?.transcript_path !== "string") return block({ recorded: "nothing - the payload has no transcript_path" });
  let summary;
  try {
    summary = await summarizeTranscript(payload.transcript_path, commandName);
  } catch {
    return block({ recorded: "nothing - the transcript could not be read" });
  }
  if (!summary) return block({ recorded: "nothing - no hetzner-axi commands this session" });
  try {
    recordSession(directoryKey(typeof payload.cwd === "string" ? payload.cwd : process.cwd()), summary);
  } catch {
    return block({ recorded: "nothing - the session log could not be written" });
  }
  return block({ recorded: sessionText(summary) });
}

export async function contextCommand(args: string[], options: ContextOptions): Promise<string> {
  const command = "hetzner-axi context";
  const parsed = parseArgs(args, [], command);
  const [sub] = expectPositionals(parsed, parsed.positionals[0] === "end" ? 1 : 0, `${command} [end]`);
  return sub === "end" ? end(options.commandName) : view(options);
}
