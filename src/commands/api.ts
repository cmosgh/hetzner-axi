import { bool, flag, parseArgs } from "../args.js";
import { hcloud } from "../client.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out, type Obj } from "../render.js";

export const API_HELP = `usage: hetzner-axi api [GET|POST|PUT|DELETE] <path> [flags]
Escape hatch for any Hetzner Cloud API endpoint (paths below https://api.hetzner.cloud/v1), sent with the active context's token.
flags:
  --query <key=value> (repeatable), --data <json> (request body), --full (do not truncate long strings), --confirm (required for DELETE)
examples[3]:
  hetzner-axi api /certificates
  hetzner-axi api /servers/42/metrics --query type=cpu --query start=2026-01-01T00:00:00Z --query end=2026-01-01T01:00:00Z
  hetzner-axi api POST /servers/42/actions/enable_rescue --data '{"type":"linux64"}'
`;

const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
type Method = (typeof METHODS)[number];
const STRING_LIMIT = 300;
const ARRAY_LIMIT = 50;

/** Raw API payloads are verbose; cap strings and arrays unless --full. */
function shrink(value: unknown, stats: { cut: boolean; full?: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length <= STRING_LIMIT) return value;
    stats.cut = true;
    return `${value.slice(0, STRING_LIMIT)}... (${value.length} chars)`;
  }
  if (Array.isArray(value)) {
    if (value.length > ARRAY_LIMIT) stats.cut = true;
    return value.slice(0, ARRAY_LIMIT).map((item) => shrink(item, stats));
  }
  if (value !== null && typeof value === "object") {
    const result: Obj = {};
    for (const [key, inner] of Object.entries(value)) {
      // Every price is listed per location; collapse to keep payloads readable.
      if (key === "prices" && !stats.full) {
        stats.cut = true;
        continue;
      }
      result[key] = shrink(inner, stats);
    }
    return result;
  }
  return value;
}

export async function apiCommand(args: string[]): Promise<string> {
  const command = "hetzner-axi api";
  const usage = `${command} [GET|POST|PUT|DELETE] <path> [--query k=v] [--data <json>]`;
  const parsed = parseArgs(
    args,
    [
      { name: "--query", repeatable: true },
      { name: "--data" },
      { name: "--full", boolean: true },
      { name: "--confirm", boolean: true },
    ],
    command,
  );

  const positionals = [...parsed.positionals];
  let method: Method = "GET";
  const first = positionals[0]?.toUpperCase();
  if (first !== undefined && (METHODS as readonly string[]).includes(first)) {
    method = first as Method;
    positionals.shift();
  }
  if (positionals.length !== 1) {
    throw usageError(positionals.length === 0 ? "missing API path" : "too many arguments", [`usage: ${usage}`]);
  }

  const path = positionals[0]!;
  if (!path.startsWith("/") || path.includes("://") || path.startsWith("/v1/")) {
    throw usageError("path must start with / and be relative to /v1 (e.g. /servers)", [`usage: ${usage}`]);
  }

  const query: Record<string, string> = {};
  for (const pair of parsed.values.get("--query") ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw usageError(`--query expects key=value, got '${pair}'`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  let body: unknown;
  const data = flag(parsed, "--data");
  if (data !== undefined) {
    if (method === "GET") throw usageError("--data needs POST or PUT", [`usage: ${usage}`]);
    try {
      body = JSON.parse(data) as unknown;
    } catch {
      throw usageError("--data is not valid JSON");
    }
  }

  if (method === "DELETE" && !bool(parsed, "--confirm")) {
    return out(
      block({ delete_preview: { path, result: "NOT executed - DELETE needs --confirm" } }),
      helpBlock([`Run \`${command} DELETE ${positionals[0]} --confirm\` to execute`]),
    );
  }

  const response = await hcloud(path, { method, query, body });
  const stats = { cut: false };
  const shown = bool(parsed, "--full") ? response : shrink(response, stats);
  const payload: Obj =
    shown !== null && typeof shown === "object" && !Array.isArray(shown)
      ? (shown as Obj)
      : { result: shown };
  return out(
    block(Object.keys(payload).length === 0 ? { result: `${method} ${path} succeeded (empty response)` } : payload),
    helpBlock(stats.cut ? ["Long strings/arrays were truncated and per-location prices dropped; add `--full` for the raw payload"] : []),
  );
}
