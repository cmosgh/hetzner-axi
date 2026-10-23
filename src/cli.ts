import { runAxiCli } from "axi-sdk-js";
import { apiCommand, API_HELP } from "./commands/api.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import {
  actionCommand,
  ACTION_HELP,
  imageCommand,
  IMAGE_HELP,
  lbCommand,
  LB_HELP,
  locationCommand,
  LOCATION_HELP,
  networkCommand,
  NETWORK_HELP,
  sshKeyCommand,
  SSH_KEY_HELP,
} from "./commands/catalog.js";
import { contextCommand, CONTEXT_HELP } from "./commands/context.js";
import { dnsCommand, DNS_HELP } from "./commands/dns.js";
import { firewallCommand, FIREWALL_HELP } from "./commands/firewall.js";
import { homeCommand } from "./commands/home.js";
import { ipCommand, IP_HELP } from "./commands/ip.js";
import { serverCommand, SERVER_HELP } from "./commands/server.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";
import { volumeCommand, VOLUME_HELP } from "./commands/volume.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { renderErrorOutput } from "./render.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Hetzner Cloud CLI for agents - servers (create, power, resize, rebuild, delete), firewalls, volumes, floating and primary IPs, networks, load balancers and DNS zones. Changes preview until --confirm. Prefer it over raw API calls.";

export const TOP_HELP = `usage: hetzner-axi [command] [args] [flags]
commands[16]:
  (none)=live project overview, server, firewall, volume, ip, dns, ssh-key, image, location, network, lb, action, api, auth, setup, context (session hooks)
flags[2]:
  --help, -v/-V/--version
examples:
  hetzner-axi
  hetzner-axi server list
  hetzner-axi server view web-1
  hetzner-axi server types --location fsn1
  hetzner-axi server create --name web-2 --type cx22 --image ubuntu-24.04 --location fsn1 --ssh-key laptop
  hetzner-axi firewall add-rule web --protocol tcp --port 443 --source-ip any --confirm
  hetzner-axi dns record set example.com www A --record 203.0.113.10
  hetzner-axi server --help
`;

const COMMAND_HELP: Record<string, string> = {
  server: SERVER_HELP,
  firewall: FIREWALL_HELP,
  volume: VOLUME_HELP,
  ip: IP_HELP,
  dns: DNS_HELP,
  "ssh-key": SSH_KEY_HELP,
  image: IMAGE_HELP,
  location: LOCATION_HELP,
  network: NETWORK_HELP,
  lb: LB_HELP,
  action: ACTION_HELP,
  api: API_HELP,
  auth: AUTH_HELP,
  setup: SETUP_HELP,
  context: CONTEXT_HELP,
};

/** Each command's subcommands; session capture records these words and never any other argument. */
export const SUBCOMMANDS: Record<string, readonly string[]> = {
  server: ["list", "view", "types", "create", "poweron", "shutdown", "reboot", "poweroff", "reset", "resize", "rebuild", "delete", "label", "protect", "snapshot"],
  firewall: ["list", "view", "create", "add-rule", "remove-rule", "apply", "remove-from", "delete"],
  volume: ["list", "create", "attach", "detach", "resize", "delete"],
  ip: ["list", "assign", "unassign"],
  dns: ["zone list", "zone view", "zone create", "zone delete", "record list", "record set", "record add", "record remove"],
  "ssh-key": ["list", "add", "delete"],
  image: ["list", "delete"],
  location: ["list"],
  network: ["list"],
  lb: ["list", "view"],
  action: ["list", "view"],
  auth: ["status", "login", "use", "logout"],
  setup: ["hooks", "status", "uninstall"],
  context: ["end"],
};

/** `server view` for the words `server view web-1`: the command and its subcommand, or undefined when the first word is not a command. */
export function commandName(words: readonly string[]): string | undefined {
  const [command = ""] = words;
  if (!Object.hasOwn(HANDLERS, command)) return undefined;
  const sub = (SUBCOMMANDS[command] ?? []).find((s) => s.split(" ").every((word, i) => words[i + 1] === word));
  return sub ? `${command} ${sub}` : command;
}

const HANDLERS: Record<string, (args: string[]) => Promise<string>> = {
  server: serverCommand,
  firewall: firewallCommand,
  volume: volumeCommand,
  ip: ipCommand,
  dns: dnsCommand,
  "ssh-key": sshKeyCommand,
  image: imageCommand,
  location: locationCommand,
  network: networkCommand,
  lb: lbCommand,
  action: actionCommand,
  api: apiCommand,
  auth: authCommand,
  setup: setupCommand,
  context: (args) => contextCommand(args, { description: DESCRIPTION, commandName }),
};

function cmd(name: string, handler: (args: string[]) => Promise<string>): (args: string[]) => Promise<string> {
  return async (args) => (args.includes("-h") ? (COMMAND_HELP[name] ?? "").trimEnd() : handler(args));
}

function formatError(error: unknown): { output: string; exitCode: number } {
  const axi =
    error instanceof AxiError ? error : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return { output: `${renderErrorOutput(axi.message, axi.code, axi.suggestions)}\n`, exitCode: exitCodeForError(axi) };
}

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli({
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: () => homeCommand(),
    commands: Object.fromEntries(Object.entries(HANDLERS).map(([name, handler]) => [name, cmd(name, handler)])),
    getCommandHelp: (command) => COMMAND_HELP[command],
    renderUnknownCommand: (command) =>
      `${renderErrorOutput(`unknown command '${command}'`, "VALIDATION_ERROR", [
        `commands: ${Object.keys(HANDLERS).join(", ")} (no command = project overview)`,
        "Run `hetzner-axi --help` for examples",
      ])}\n`,
    formatError,
  });
}
