import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Non-secret settings only. Tokens live in the OS keychain, never here. */
export interface Config {
  /** Context (Hetzner project) used when none is selected explicitly. */
  active?: string;
  /** Names of the contexts with a stored token. */
  contexts?: string[];
}

export function configDir(): string {
  const override = process.env["HETZNER_AXI_CONFIG_DIR"];
  if (override) return override;
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "hetzner-axi");
}

export function readConfig(): Config {
  const path = join(configDir(), "config.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Config) : {};
  } catch {
    // A corrupt file must not brick the CLI; treat it as empty.
    return {};
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
