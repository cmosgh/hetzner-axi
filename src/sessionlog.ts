import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { configDir } from "./config.js";
import { validContextName } from "./credentials.js";

const NAME = "hetzner-axi";

/** What one agent session did with hetzner-axi: command names and counts, never their arguments. */
export interface SessionSummary {
  ended: string;
  commands: Record<string, number>;
  /** The HETZNER_AXI_CONTEXT value used most, so the next session knows which project it worked in. */
  context?: string;
}

interface SessionLog {
  directories: Record<string, SessionSummary>;
}

const MAX_DIRECTORIES = 100;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/** Words between shell separators, with quotes and escapes resolved. Good enough to find our own invocations. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let token = "";
  let started = false;
  let quote: string | undefined;
  const end = (): void => {
    if (started) segments[segments.length - 1]!.push(token);
    token = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      token += command[++i];
      started = true;
    } else if (";|&()`\n".includes(c)) {
      end();
      segments.push([]);
    } else if (/\s/.test(c)) {
      end();
    } else {
      token += c;
      started = true;
    }
  }
  end();
  return segments.filter((s) => s.length > 0);
}

const WRAPPERS = new Set(["npx", "-y", "--yes", "pnpm", "dlx", "exec", "command", "time", "env", "node"]);
const CONTEXT_VARIABLE = "HETZNER_AXI_CONTEXT";

export interface Invocation {
  command: string;
  context?: string;
}

/** Resolves an invocation's leading words to its command name, e.g. `server list`; undefined when the first word is not a command. */
export type CommandLookup = (words: readonly string[]) => string | undefined;

/** This tool's invocations in one shell command line. Unknown commands count as `other`, so no argument is recorded. */
export function findInvocations(commandLine: string, name: string, commandName: CommandLookup): Invocation[] {
  const found: Invocation[] = [];
  for (const words of shellSegments(commandLine)) {
    let i = 0;
    let context: string | undefined;
    for (; i < words.length; i++) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(words[i]!);
      if (assignment) {
        if (assignment[1] === CONTEXT_VARIABLE && validContextName(assignment[2]!)) context = assignment[2];
      } else if (!WRAPPERS.has(words[i]!)) break;
    }
    // `npx -y hetzner-axi@latest` and `node .../dist/bin/hetzner-axi.js` run it too.
    const base = (words[i] ?? "").split("/").pop()!.replace(/@[^@]*$/, "");
    if (base !== name && base !== `${name}.js`) continue;
    const args = words.slice(i + 1);
    const flagAt = args.findIndex((word) => word.startsWith("-"));
    const lead = flagAt === -1 ? args : args.slice(0, flagAt);
    let command: string;
    if (lead.length > 0) command = commandName(lead) ?? "other";
    else if (args.length === 0) command = "home";
    else if (args[0] === "--help" || args[0] === "-h") command = "help";
    else if (args[0] === "--version" || args[0] === "-v" || args[0] === "-V") command = "version";
    else command = "other";
    found.push({ command, ...(context ? { context } : {}) });
  }
  return found;
}

/** Claude Code transcript lines are JSON; tool calls carry `input.command` for shell tools. */
function* toolCommands(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* toolCommands(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record["type"] === "tool_use") {
    const input = record["input"] as Record<string, unknown> | undefined;
    if (typeof input?.["command"] === "string") yield input["command"];
    return;
  }
  for (const key of ["message", "content"]) if (key in record) yield* toolCommands(record[key]);
}

const mostUsed = (values: Array<string | undefined>): string | undefined => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** Reads a transcript and sums this tool's invocations; undefined when it holds none. */
export async function summarizeTranscript(path: string, commandName: CommandLookup): Promise<SessionSummary | undefined> {
  if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return undefined;
  const invocations: Invocation[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(NAME)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const command of toolCommands(entry)) invocations.push(...findInvocations(command, NAME, commandName));
  }
  if (invocations.length === 0) return undefined;
  const commands: Record<string, number> = {};
  for (const inv of invocations) commands[inv.command] = (commands[inv.command] ?? 0) + 1;
  const context = mostUsed(invocations.map((i) => i.context));
  return { ended: new Date().toISOString().slice(0, 10), commands, ...(context ? { context } : {}) };
}

const logPath = (): string => join(configDir(), "sessions.json");

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function readLog(): SessionLog {
  try {
    const parsed = JSON.parse(readFileSync(logPath(), "utf-8")) as SessionLog;
    return isRecord(parsed?.directories) ? parsed : { directories: {} };
  } catch {
    return { directories: {} };
  }
}

/** Keeps the latest session per directory, and only the most recent directories. */
export function recordSession(directory: string, summary: SessionSummary): void {
  const log = readLog();
  delete log.directories[directory];
  log.directories[directory] = summary;
  const names = Object.keys(log.directories);
  for (const old of names.slice(0, Math.max(0, names.length - MAX_DIRECTORIES))) delete log.directories[old];
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(logPath(), `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });
}

export function lastSession(directory: string): SessionSummary | undefined {
  const entry: unknown = existsSync(logPath()) ? readLog().directories[directory] : undefined;
  // A hand-edited entry is skipped; the next `context end` replaces it.
  return isRecord(entry) && typeof entry["ended"] === "string" && isRecord(entry["commands"]) ? (entry as unknown as SessionSummary) : undefined;
}

/** `2026-10-23 - server list 3; server view 1 - context staging` */
export function sessionText(summary: SessionSummary): string {
  const commands = Object.entries(summary.commands)
    .sort((a, b) => b[1] - a[1])
    .map(([command, n]) => `${command} ${n}`)
    .join("; ");
  return `${summary.ended} - ${commands}${summary.context ? ` - context ${summary.context}` : ""}`;
}
