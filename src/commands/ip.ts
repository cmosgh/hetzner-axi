import { bool, expectPositionals, flag, parseArgs, parseFields, requireFlag } from "../args.js";
import { hcloud, listAll } from "../client.js";
import { axiError, usageError } from "../errors.js";
import { block, extraFields, helpBlock, num, obj, out, str, type Fields, type Obj } from "../render.js";
import { CONFIRM_FLAG, findOne, preview, runningHelp, settle, WAIT_FLAGS, waitSeconds } from "../resources.js";

/** `ip list` extras; the default row is ip, kind, server, location. */
const LIST_FIELDS: Fields = {
  name: (ip) => str(ip["name"]),
  id: (ip) => num(ip["id"]),
};

export const IP_HELP = `usage: hetzner-axi ip <list|assign|unassign> [args] [flags]
Floating IPs and primary IPs. <ip> is the address, the name, or the numeric id.
flags{list}:
  --fields <${Object.keys(LIST_FIELDS).join(",")}>
flags{assign}:
  --server <name|id> (required), --confirm, --no-wait, --wait <seconds>
flags{unassign}:
  --confirm, --no-wait, --wait <seconds>
notes:
  Floating IPs move between running servers instantly (configure the address on the server too). Primary IPs only move while the server is off.
examples[3]:
  hetzner-axi ip list
  hetzner-axi ip assign 203.0.113.10 --server web-2 --confirm
  hetzner-axi ip unassign 203.0.113.10 --confirm
`;

interface Address {
  kind: "floating" | "primary";
  raw: Obj;
}

async function allAddresses(): Promise<Address[]> {
  const [floating, primary] = await Promise.all([listAll("/floating_ips", "floating_ips"), listAll("/primary_ips", "primary_ips")]);
  return [...floating.items.map((raw) => ({ kind: "floating" as const, raw })), ...primary.items.map((raw) => ({ kind: "primary" as const, raw }))];
}

function assignee(address: Address): number | undefined {
  return address.kind === "floating" ? num(address.raw["server"]) : num(address.raw["assignee_id"]);
}

async function findAddress(ref: string): Promise<Address> {
  const all = await allAddresses();
  // IPv6 blocks are listed as networks (2001:db8::/64); accept the bare prefix too.
  const match = all.find((a) => str(a.raw["ip"]) === ref || str(a.raw["ip"]).split("/")[0] === ref || str(a.raw["name"]) === ref || String(num(a.raw["id"])) === ref);
  if (!match) throw axiError(`no floating or primary IP '${ref}'`, "NOT_FOUND", ["Run `hetzner-axi ip list`"]);
  return match;
}

export async function ipCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "list") return ipList(rest);
  if (sub === "assign") return ipAssign(rest);
  if (sub === "unassign") return ipUnassign(rest);
  throw usageError(sub ? `unknown ip subcommand '${sub}'` : "missing ip subcommand", ["subcommands: list, assign, unassign"]);
}

async function ipList(args: string[]): Promise<string> {
  const command = "hetzner-axi ip list";
  const parsed = parseArgs(args, [{ name: "--fields" }], command);
  expectPositionals(parsed, 0, command);
  const extras = parseFields(flag(parsed, "--fields"), Object.keys(LIST_FIELDS));
  const [addresses, servers] = await Promise.all([allAddresses(), listAll("/servers", "servers", {}, 1000)]);
  if (addresses.length === 0) return block({ ips: "0 floating or primary IPs in this project" });
  const names = new Map(servers.items.map((s) => [num(s["id"]) ?? 0, str(s["name"])]));
  return block({
    ips: addresses.map((a) => ({
      ip: str(a.raw["ip"]),
      kind: a.kind,
      server: assignee(a) ? (names.get(assignee(a)!) ?? `id ${assignee(a)}`) : "unassigned",
      location: str(obj(a.kind === "floating" ? a.raw["home_location"] : a.raw["location"])["name"]),
      ...extraFields(a.raw, extras, LIST_FIELDS),
    })),
  });
}

async function ipAssign(args: string[]): Promise<string> {
  const command = "hetzner-axi ip assign";
  const parsed = parseArgs(args, [{ name: "--server" }, CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const usage = `${command} <ip> --server <name|id> --confirm`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const serverRef = requireFlag(parsed, "--server", usage);
  const [address, server] = await Promise.all([findAddress(ref!), findOne("servers", "server", serverRef)]);
  const ip = str(address.raw["ip"]);
  const name = str(server["name"]);
  const current = assignee(address);
  if (current === num(server["id"])) return block({ ip, server: name, result: "already assigned (no-op)" });
  if (address.kind === "primary") {
    if (current) throw usageError(`${ip} is assigned to server ${current}`, [`Run \`hetzner-axi ip unassign ${ip} --confirm\` first (that server must be off)`]);
    if (str(server["status"]) !== "off") throw usageError(`primary IPs only move to a stopped server; ${name} is ${str(server["status"])}`, [`Run \`hetzner-axi server shutdown ${name} --confirm\``]);
  }
  if (!bool(parsed, "--confirm")) {
    return preview({ ip, kind: address.kind, from: current ? `server ${current}` : "unassigned", to: name, effect: "traffic for this IP goes to the new server" }, `${command} ${ip} --server ${name}`, [
      ...(address.kind === "floating" ? ["Configure the floating IP on the server's network interface as well"] : []),
    ]);
  }
  const id = num(address.raw["id"]);
  const response =
    address.kind === "floating"
      ? await hcloud(`/floating_ips/${id}/actions/assign`, { method: "POST", body: { server: num(server["id"]) } })
      : await hcloud(`/primary_ips/${id}/actions/assign`, { method: "POST", body: { assignee_type: "server", assignee_id: num(server["id"]) } });
  const { result, text } = await settle(response["action"], waitSeconds(parsed));
  return out(block({ ip, server: name, result: `assign ${text}` }), helpBlock(runningHelp(result)));
}

async function ipUnassign(args: string[]): Promise<string> {
  const command = "hetzner-axi ip unassign";
  const parsed = parseArgs(args, [CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <ip> --confirm`);
  const address = await findAddress(ref!);
  const ip = str(address.raw["ip"]);
  const current = assignee(address);
  if (!current) return block({ ip, result: "already unassigned (no-op)" });
  if (address.kind === "primary") {
    const server = obj((await hcloud(`/servers/${current}`))["server"]);
    if (str(server["status"]) !== "off") throw usageError(`primary IPs only detach from a stopped server; ${str(server["name"])} is ${str(server["status"])}`);
  }
  if (!bool(parsed, "--confirm")) return preview({ ip, kind: address.kind, server: current, effect: "the server stops answering on this IP" }, `${command} ${ip}`);
  const id = num(address.raw["id"]);
  const response = await hcloud(`/${address.kind === "floating" ? "floating_ips" : "primary_ips"}/${id}/actions/unassign`, { method: "POST" });
  const { result, text } = await settle(response["action"], waitSeconds(parsed));
  return out(block({ ip, result: `unassign ${text}` }), helpBlock(runningHelp(result)));
}
