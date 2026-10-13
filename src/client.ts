import { requireCredentials, type Credentials } from "./credentials.js";
import { axiError, AxiError } from "./errors.js";
import { arr, num, obj, str, type Obj } from "./render.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE = "https://api.hetzner.cloud/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
/** The API maximum; fewer round trips for list commands. */
export const PER_PAGE = 50;

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /** Supply credentials explicitly (used by `auth login` before storing). */
  credentials?: Credentials;
}

export function apiBase(): string {
  const override = process.env["HETZNER_AXI_API_BASE"];
  if (!override) return DEFAULT_BASE;
  const url = new URL(override);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  // The bearer token goes wherever this points - never plain HTTP to a remote host.
  if (url.protocol !== "https:" && !local) throw axiError("HETZNER_AXI_API_BASE must use https", "VALIDATION_ERROR");
  return override.replace(/\/+$/, "");
}

export function buildUrl(base: string, path: string, query?: Query): URL {
  const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
  // Only ever send the token to the configured API base.
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname)) {
    throw axiError(`refusing to send credentials to ${url.origin}${url.pathname}`, "API_ERROR");
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "object") for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

/** `{error: {code, message, details: {fields: [{name, messages}]}}}` -> one line. */
export function apiError(bodyText: string): { code: string; message: string } {
  try {
    const error = obj(obj(JSON.parse(bodyText))["error"]);
    const fields = arr(obj(error["details"])["fields"])
      .map(obj)
      .map((f) => `${str(f["name"])} - ${arr(f["messages"]).map(str).join(" ")}`);
    return { code: str(error["code"]), message: [str(error["message"]), ...fields].filter(Boolean).join("; ").slice(0, 400) };
  } catch {
    return { code: "", message: "" };
  }
}

function errorForStatus(status: number, bodyText: string, method: string): AxiError {
  const { code, message } = apiError(bodyText);
  const suffix = message ? `: ${message}` : "";
  if (status === 401) {
    return axiError(`Hetzner rejected the token${suffix}`, "AUTH_REQUIRED", [
      "The token is invalid or was revoked; create a new one in the Cloud Console under Security - API tokens",
      "Run `hetzner-axi auth status` to see which context is in use",
    ]);
  }
  if (status === 403 && code === "forbidden" && method !== "GET") {
    return axiError(`access denied${suffix}`, "FORBIDDEN", ["A Read token cannot change anything; use a Read & Write token for this project"]);
  }
  if (code === "protected") {
    return axiError(`the resource is protected${suffix}`, "PROTECTED", ["Remove the protection first (e.g. `hetzner-axi server protect <server> --delete off`)"]);
  }
  if (code === "locked") return axiError(`another action is still running on this resource${suffix}`, "CONFLICT", ["Run `hetzner-axi action list --running` and retry once it finished"]);
  if (code === "uniqueness_error") return axiError(`a resource with this value already exists${suffix}`, "CONFLICT");
  if (code === "resource_limit_exceeded") return axiError(`project resource limit reached${suffix}`, "FORBIDDEN", ["Delete unused resources or ask Hetzner to raise the limit"]);
  if (code === "resource_unavailable" || code === "unavailable") {
    return axiError(`not available right now${suffix}`, "API_ERROR", ["Try another location or server type (`hetzner-axi server types`)"]);
  }
  switch (status) {
    case 400:
    case 422:
      return axiError(`Hetzner rejected the request${suffix}`, "VALIDATION_ERROR");
    case 403:
      return axiError(`access denied${suffix}`, "FORBIDDEN");
    case 404:
      return axiError(`not found${suffix}`, "NOT_FOUND");
    case 409:
      return axiError(`conflict${suffix}`, "CONFLICT", ["Retry; the resource changed during the request"]);
    case 429:
      return axiError("Hetzner API rate limit reached (3600 requests per hour)", "RATE_LIMITED", ["Wait a few minutes before retrying"]);
    default:
      return axiError(`Hetzner API error ${status}${suffix}`, "API_ERROR");
  }
}

export async function hcloud(path: string, options: RequestOptions = {}): Promise<Obj> {
  const method = options.method ?? "GET";
  const credentials = options.credentials ?? (await requireCredentials());
  const url = buildUrl(apiBase(), path, options.query);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.token}`,
    "User-Agent": `hetzner-axi/${VERSION}`,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw axiError(timedOut ? "Hetzner API request timed out" : "could not reach the Hetzner API", "NETWORK", [
      "Check the network connection and retry",
    ]);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw errorForStatus(response.status, text, method);
  if (response.status === 204 || text.trim() === "") return {};
  try {
    return obj(JSON.parse(text));
  } catch {
    throw axiError("Hetzner API returned a non-JSON response", "API_ERROR");
  }
}

export interface Page {
  items: Obj[];
  /** Total across all pages when the API reports it. */
  total: number | undefined;
}

/** Follow `meta.pagination` until `limit` items are collected. */
export async function listAll(path: string, key: string, query: Query = {}, limit = 1000, timeoutMs?: number): Promise<Page> {
  const items: Obj[] = [];
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const body = await hcloud(path, { query: { ...query, page, per_page: PER_PAGE }, ...(timeoutMs ? { timeoutMs } : {}) });
    items.push(...arr(body[key]).map(obj));
    const pagination = obj(obj(body["meta"])["pagination"]);
    total = num(pagination["total_entries"]) ?? total;
    if (items.length >= limit || !num(pagination["next_page"])) break;
  }
  return { items: items.slice(0, limit), total };
}

export interface ActionResult {
  id: number;
  command: string;
  status: "success" | "running" | "error";
}


/**
 * Poll an action until it finishes or `waitSeconds` passes. A failed action
 * throws; one still running after the wait is returned as "running".
 */
export async function waitAction(action: unknown, waitSeconds: number): Promise<ActionResult> {
  // Overridable so tests do not sleep.
  const pollMs = Number(process.env["HETZNER_AXI_POLL_MS"] ?? 1000);
  let current = obj(action);
  const id = num(current["id"]) ?? 0;
  const deadline = Date.now() + waitSeconds * 1000;
  while (str(current["status"]) === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = obj((await hcloud(`/actions/${id}`))["action"]);
  }
  const status = str(current["status"]);
  if (status === "error") {
    const error = obj(current["error"]);
    throw axiError(`action ${str(current["command"])} (${id}) failed: ${str(error["message"]) || str(error["code"]) || "unknown error"}`, "ACTION_FAILED", [
      `Run \`hetzner-axi action view ${id}\``,
    ]);
  }
  return { id, command: str(current["command"]), status: status === "success" ? "success" : "running" };
}
