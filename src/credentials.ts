import { readConfig } from "./config.js";
import { axiError, usageError } from "./errors.js";

const KEYCHAIN_SERVICE = "hetzner-axi";

export interface Credentials {
  token: string;
  /** Context name, or "HCLOUD_TOKEN" for the environment. */
  context: string;
  source: "env" | "keychain";
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(context: string): Promise<KeyringEntry> {
  try {
    // Loaded lazily: an unsupported platform degrades to the env-var path.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(KEYCHAIN_SERVICE, context);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [
      "Set HCLOUD_TOKEN in the environment instead",
    ]);
  }
}

/** HETZNER_AXI_NO_KEYCHAIN=1: the OS keychain is never read or written. */
export function keychainDisabled(): boolean {
  return process.env["HETZNER_AXI_NO_KEYCHAIN"] === "1";
}

const KEYCHAIN_OFF = "HETZNER_AXI_NO_KEYCHAIN=1 disables the OS keychain";

/** auth login calls this before reading the token, so a refusal costs nothing. */
export function assertCanStoreToken(): void {
  if (keychainDisabled()) {
    throw usageError(`${KEYCHAIN_OFF} so auth login cannot store the token`, [
      "Set HCLOUD_TOKEN in the environment instead - it needs no keychain",
      "Or unset HETZNER_AXI_NO_KEYCHAIN to store the token in the OS keychain",
    ]);
  }
}

export function validContextName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name);
}

/** The context a command runs against: HETZNER_AXI_CONTEXT, then the active one. */
export function selectedContext(): string | undefined {
  return process.env["HETZNER_AXI_CONTEXT"] || readConfig().active;
}

/** HCLOUD_TOKEN (shared with the hcloud CLI) wins over the keychain. */
export async function resolveCredentials(): Promise<Credentials | undefined> {
  const envToken = process.env["HCLOUD_TOKEN"];
  if (envToken) return { token: envToken, context: "HCLOUD_TOKEN", source: "env" };
  if (keychainDisabled()) return undefined;
  const context = selectedContext();
  if (!context) return undefined;
  try {
    const token = (await keychainEntry(context)).getPassword();
    return token ? { token, context, source: "keychain" } : undefined;
  } catch {
    return undefined;
  }
}

export const LOGIN_HINT = "Run `<token-command> | hetzner-axi auth login --context <project-name> --token-stdin`";

/** Why there are no credentials while the keychain is off; auth login would be refused. */
export const KEYCHAIN_OFF_STATUS = "HCLOUD_TOKEN is not set and HETZNER_AXI_NO_KEYCHAIN=1 keeps the keychain off";
export const KEYCHAIN_OFF_HELP = ["Set HCLOUD_TOKEN in the environment", "Or unset HETZNER_AXI_NO_KEYCHAIN to use the OS keychain"];

export async function requireCredentials(): Promise<Credentials> {
  const credentials = await resolveCredentials();
  if (!credentials) {
    if (keychainDisabled()) throw axiError(`not authenticated - ${KEYCHAIN_OFF_STATUS}`, "AUTH_REQUIRED", KEYCHAIN_OFF_HELP);
    const context = selectedContext();
    throw axiError(context ? `no token stored for context '${context}'` : "not authenticated with Hetzner Cloud", "AUTH_REQUIRED", [
      LOGIN_HINT,
      "Or set HCLOUD_TOKEN in the environment",
    ]);
  }
  return credentials;
}

export async function storeToken(context: string, token: string): Promise<void> {
  assertCanStoreToken();
  (await keychainEntry(context)).setPassword(token);
}

/** Returns true when a stored token was removed, false when there was none. */
export async function clearToken(context: string): Promise<boolean> {
  if (keychainDisabled()) {
    throw usageError(`${KEYCHAIN_OFF} so the token of context '${context}' cannot be removed`, [
      `Unset HETZNER_AXI_NO_KEYCHAIN and run \`hetzner-axi auth logout --context ${context}\``,
    ]);
  }
  try {
    return (await keychainEntry(context)).deletePassword();
  } catch {
    return false;
  }
}
