import { flag, bool, intFlag, type FlagSpec, type ParsedArgs } from "./args.js";
import { hcloud, listAll, waitAction, type ActionResult } from "./client.js";
import { axiError, usageError } from "./errors.js";
import { arr, block, helpBlock, num, obj, out, str, type Obj } from "./render.js";

/** The CLI noun that lists each collection findOne() resolves. */
const LIST_NOUNS: Record<string, string> = {
  servers: "server",
  firewalls: "firewall",
  volumes: "volume",
  ssh_keys: "ssh-key",
  networks: "network",
  load_balancers: "lb",
};

/** Resolve a resource by numeric id or exact name; misses list close names. */
export async function findOne(collection: string, key: string, ref: string, label = key.replace(/_/g, " ")): Promise<Obj> {
  if (/^\d+$/.test(ref)) {
    try {
      return obj((await hcloud(`/${collection}/${ref}`))[key]);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as { code: string }).code === "NOT_FOUND")) throw error;
      // Fall through: a numeric-looking name.
    }
  }
  const byName = arr((await hcloud(`/${collection}`, { query: { name: ref } }))[`${key}s`]).map(obj);
  const match = byName.find((item) => str(item["name"]) === ref);
  if (match) return match;
  const all = (await listAll(`/${collection}`, `${key}s`, {}, 200)).items.map((item) => str(item["name"]));
  const close = all.filter((name) => name.toLowerCase().includes(ref.toLowerCase()) || ref.toLowerCase().includes(name.toLowerCase()));
  const noun = LIST_NOUNS[collection];
  throw axiError(`no ${label} named '${ref}'`, "NOT_FOUND", [
    ...(close.length > 0 ? [`did you mean: ${close.slice(0, 5).join(", ")}`] : all.length > 0 ? [`${all.length} ${label}s exist: ${all.slice(0, 8).join(", ")}${all.length > 8 ? ", ..." : ""}`] : [`0 ${label}s in this project`]),
    ...(noun ? [`Run \`hetzner-axi ${noun} list\``] : []),
  ]);
}

/** Labels render as `k=v; k2` (TOON-friendly, no commas). */
export function formatLabels(labels: unknown): string {
  const entries = Object.entries(obj(labels));
  return entries.length === 0 ? "none" : entries.map(([k, v]) => (v === "" ? k : `${k}=${String(v)}`)).join("; ");
}

export function parseLabels(values: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const raw of values) {
    for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      const key = eq === -1 ? part : part.slice(0, eq);
      if (!/^([a-z0-9A-Z]([a-z0-9A-Z._-]*[a-z0-9A-Z])?\/)?[a-z0-9A-Z]([a-z0-9A-Z._-]{0,61}[a-z0-9A-Z])?$/.test(key)) {
        throw usageError(`invalid label key '${key}'`, ["Label keys are up to 63 chars of letters, digits, '-', '_' and '.'"]);
      }
      labels[key] = eq === -1 ? "" : part.slice(eq + 1);
    }
  }
  return labels;
}

/** Gross monthly EUR price for a location (or the cheapest) as a number. */
export function monthlyPrice(prices: unknown, location?: string): number | undefined {
  const rows = arr(prices).map(obj);
  const pick = location ? rows.filter((p) => str(p["location"]) === location) : rows;
  const values = pick.map((p) => Number(str(obj(p["price_monthly"])["gross"]))).filter((n) => Number.isFinite(n));
  if (values.length === 0) return undefined;
  return Math.round(Math.min(...values) * 100) / 100;
}

export function hourlyPrice(prices: unknown, location: string): number | undefined {
  const row = arr(prices).map(obj).find((p) => str(p["location"]) === location);
  const value = Number(str(obj(row?.["price_hourly"])["gross"]));
  return Number.isFinite(value) && row ? Math.round(value * 10000) / 10000 : undefined;
}

export function gb(value: unknown): string {
  const n = num(value);
  return n === undefined ? "unknown" : `${n} GB`;
}

// --- mutations: preview without --confirm, wait for the action unless --no-wait ---

export const WAIT_FLAGS: FlagSpec[] = [{ name: "--no-wait", boolean: true }, { name: "--wait" }];
export const CONFIRM_FLAG: FlagSpec = { name: "--confirm", boolean: true };

export function waitSeconds(parsed: ParsedArgs, fallback = 180): number {
  if (bool(parsed, "--no-wait")) return 0;
  return flag(parsed, "--wait") === undefined ? fallback : intFlag(parsed, "--wait", fallback, { min: 1, max: 1800 });
}

export function preview(what: Obj, rerun: string, extraHelp: string[] = []): string {
  return out(block({ preview: { ...what, result: "NOT executed - add --confirm" } }), helpBlock([`Run \`${rerun} --confirm\` to execute`, ...extraHelp]));
}

/** Wait for an action and describe the outcome in one value. */
export async function settle(action: unknown, seconds: number): Promise<{ result: ActionResult; text: string }> {
  const result = await waitAction(action, seconds);
  return { result, text: result.status === "success" ? "done" : `running (action ${result.id})` };
}

export function runningHelp(result: ActionResult): string[] {
  return result.status === "running" ? [`Run \`hetzner-axi action view ${result.id}\` to follow it`] : [];
}
