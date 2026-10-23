import { listAll } from "../client.js";
import { readConfig } from "../config.js";
import { resolveCredentials } from "../credentials.js";
import { AxiError } from "../errors.js";
import { block, helpBlock, out, str, type Obj } from "../render.js";
import { serverRow } from "./server.js";

/** Agents often run the live overview first: keep it fast and tiny. */
const HOME_TIMEOUT_MS = 8_000;
const HOME_ROWS = 5;

export async function homeCommand(): Promise<string> {
  const config = readConfig();
  const configured = Boolean(process.env["HCLOUD_TOKEN"]) || (config.contexts ?? []).length > 0;
  if (!configured) {
    // No keychain or network access until the user has set hetzner-axi up.
    return out(block({ hetzner: "not configured" }), helpBlock(["Run `<token-command> | hetzner-axi auth login --context <project-name> --token-stdin`"]));
  }
  const credentials = await resolveCredentials();
  if (!credentials) return out(block({ hetzner: "not authenticated" }), helpBlock(["Run `hetzner-axi auth status`"]));
  try {
    const { items, total } = await listAll("/servers", "servers", { sort: "name:asc" }, 200, HOME_TIMEOUT_MS);
    const summary: Obj = { context: credentials.context };
    if (items.length === 0) {
      summary["servers"] = "0 servers in this project";
    } else {
      const byStatus = new Map<string, number>();
      for (const server of items) byStatus.set(str(server["status"]), (byStatus.get(str(server["status"])) ?? 0) + 1);
      summary["server_count"] = `${total ?? items.length} (${[...byStatus].map(([s, n]) => `${n} ${s}`).join("; ")})`;
      // Not-running servers first: they are the ones an agent is likely asked about.
      const ordered = [...items.filter((s) => str(s["status"]) !== "running"), ...items.filter((s) => str(s["status"]) === "running")];
      summary["servers"] = ordered.slice(0, HOME_ROWS).map((s) => serverRow(s));
    }
    const help: string[] = [];
    if (items.length > HOME_ROWS) help.push("Run `hetzner-axi server list` for all servers");
    help.push("Run `hetzner-axi server view <name>` for details", "Run `hetzner-axi --help` for every command");
    if ((config.contexts ?? []).length > 1 && credentials.source === "keychain") help.push(`Other projects: ${(config.contexts ?? []).filter((c) => c !== credentials.context).join(", ")} (\`hetzner-axi auth use <context>\`)`);
    return out(block(summary), helpBlock(help));
  } catch (error) {
    const message = error instanceof AxiError ? error.message : "request failed";
    return out(block({ hetzner: `unavailable - ${message}` }), helpBlock(["Run `hetzner-axi auth status` to check the token"]));
  }
}
