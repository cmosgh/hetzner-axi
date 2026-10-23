import { readFileSync } from "node:fs";
import { bool, expectPositionals, flag, parseArgs, requireFlag } from "../args.js";
import { hcloud } from "../client.js";
import { readConfig, writeConfig } from "../config.js";
import {
  assertCanStoreToken,
  clearToken,
  KEYCHAIN_OFF_HELP,
  KEYCHAIN_OFF_STATUS,
  keychainDisabled,
  LOGIN_HINT,
  resolveCredentials,
  selectedContext,
  storeToken,
  validContextName,
  type Credentials,
} from "../credentials.js";
import { AxiError, usageError } from "../errors.js";
import { block, helpBlock, num, obj, out } from "../render.js";

export const AUTH_HELP = `usage: hetzner-axi auth <subcommand> [flags]
subcommands[4]:
  status, login, use <context>, logout
flags{login}:
  --context <name> (required; usually the Hetzner project name), --token-stdin (required; the token is read from stdin, never from argv)
flags{logout}:
  --context <name> (default: the active context)
notes:
  Hetzner Cloud tokens belong to one project: store one context per project and switch with \`auth use\`. Create tokens in the Cloud Console under Security - API tokens; a Read token is enough for everything except changes.
  Tokens are stored in the OS keychain. HCLOUD_TOKEN (shared with the hcloud CLI) overrides them; HETZNER_AXI_CONTEXT picks a stored context for one command.
  HETZNER_AXI_NO_KEYCHAIN=1 never reads or writes the keychain, so login and logout are refused; use HCLOUD_TOKEN with it.
examples[4]:
  pbpaste | hetzner-axi auth login --context prod --token-stdin
  hetzner-axi auth status
  hetzner-axi auth use staging
  hetzner-axi auth logout --context staging
`;

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "use") return authUse(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", ["subcommands: status, login, use, logout"]);
}

/**
 * Read vs Read & Write without side effects: an empty ssh-key create fails
 * permission checks (403) before input validation (422).
 */
export async function probeAccess(credentials: Credentials): Promise<"read & write" | "read" | "invalid" | "unknown"> {
  try {
    await hcloud("/servers", { query: { per_page: 1 }, credentials, timeoutMs: 10_000 });
  } catch (error) {
    return error instanceof AxiError && error.code === "AUTH_REQUIRED" ? "invalid" : "unknown";
  }
  try {
    await hcloud("/ssh_keys", { method: "POST", body: {}, credentials, timeoutMs: 10_000 });
    return "unknown";
  } catch (error) {
    if (!(error instanceof AxiError)) return "unknown";
    if (error.code === "FORBIDDEN") return "read";
    return error.code === "VALIDATION_ERROR" ? "read & write" : "unknown";
  }
}

async function authStatus(args: string[]): Promise<string> {
  const command = "hetzner-axi auth status";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const config = readConfig();
  const credentials = await resolveCredentials();
  const contexts = (config.contexts ?? []).map((c) => (c === config.active ? `${c} (active)` : c)).join("; ") || "none";
  if (!credentials) {
    if (keychainDisabled()) return out(block({ auth: { status: KEYCHAIN_OFF_STATUS, contexts } }), helpBlock(KEYCHAIN_OFF_HELP));
    const context = selectedContext();
    return out(block({ auth: { status: context ? `no token stored for context '${context}'` : "not authenticated", contexts } }), helpBlock([LOGIN_HINT]));
  }
  const access = await probeAccess(credentials);
  let servers: number | undefined;
  if (access !== "invalid") servers = num(obj(obj((await hcloud("/servers", { query: { per_page: 1 }, credentials }).catch((): Record<string, unknown> => ({})))["meta"])["pagination"])["total_entries"]);
  return out(
    block({
      auth: {
        status: access === "invalid" ? "token rejected" : "ok",
        context: credentials.context,
        source: credentials.source === "env" ? "HCLOUD_TOKEN" : "OS keychain",
        access,
        ...(servers !== undefined ? { servers } : {}),
        contexts,
      },
    }),
    helpBlock(access === "invalid" ? [LOGIN_HINT] : access === "read" ? ["This is a Read token: every change will be refused with FORBIDDEN"] : []),
  );
}

async function authLogin(args: string[]): Promise<string> {
  const command = "hetzner-axi auth login";
  const usage = `<token-command> | ${command} --context <name> --token-stdin`;
  const parsed = parseArgs(args, [{ name: "--context" }, { name: "--token-stdin", boolean: true }], command);
  expectPositionals(parsed, 0, usage);
  const context = requireFlag(parsed, "--context", usage);
  if (!validContextName(context)) throw usageError(`invalid context name '${context}' - use letters, digits, '.', '_' and '-'`);
  if (!bool(parsed, "--token-stdin")) throw usageError("--token-stdin is required: the token is only ever read from stdin", [usage]);
  assertCanStoreToken();
  if (process.stdin.isTTY) throw usageError("no token on stdin (hetzner-axi never prompts)", [usage]);
  const token = readFileSync(0, "utf-8").trim();
  if (token === "") throw usageError("the token read from stdin is empty", [usage]);

  // Validate before storing so a typo never replaces a working credential.
  const credentials: Credentials = { token, context, source: "env" };
  const access = await probeAccess(credentials);
  if (access === "invalid") throw new AxiError("Hetzner rejected the token", "AUTH_REQUIRED", ["Check you copied the whole token and that it was not revoked"]);
  await storeToken(context, token);
  const config = readConfig();
  const contexts = [...new Set([...(config.contexts ?? []), context])].sort();
  writeConfig({ ...config, contexts, active: context });
  return out(
    block({ auth: { status: "logged in", context, access, active: "yes", stored: "OS keychain" } }),
    helpBlock(["Run `hetzner-axi` for an overview of the project", ...(contexts.length > 1 ? [`Switch projects with \`hetzner-axi auth use <${contexts.join("|")}>\``] : [])]),
  );
}

async function authUse(args: string[]): Promise<string> {
  const command = "hetzner-axi auth use";
  const [context] = expectPositionals(parseArgs(args, [], command), 1, `${command} <context>`);
  const config = readConfig();
  if (!(config.contexts ?? []).includes(context!)) {
    throw usageError(`no stored context '${context}'`, [`contexts: ${(config.contexts ?? []).join(", ") || "none"}`, LOGIN_HINT]);
  }
  if (config.active === context) return block({ auth: { active: context, result: "already active (no-op)" } });
  writeConfig({ ...config, active: context });
  return out(block({ auth: { active: context, result: "switched" } }), helpBlock(process.env["HCLOUD_TOKEN"] ? ["HCLOUD_TOKEN is set and still overrides the stored contexts"] : []));
}

async function authLogout(args: string[]): Promise<string> {
  const command = "hetzner-axi auth logout";
  const parsed = parseArgs(args, [{ name: "--context" }], command);
  expectPositionals(parsed, 0, `${command} [--context <name>]`);
  const config = readConfig();
  const context = flag(parsed, "--context") ?? config.active;
  if (!context || !(config.contexts ?? []).includes(context)) return block({ auth: { status: "no stored credential (no-op)" } });
  const removed = await clearToken(context);
  const contexts = (config.contexts ?? []).filter((c) => c !== context);
  const active = config.active === context ? contexts[0] : config.active;
  writeConfig({ ...(active ? { active } : {}), contexts });
  return block({ auth: { context, status: removed ? "logged out - token removed from the OS keychain" : "no stored token found (no-op)", active: active ?? "none" } });
}
