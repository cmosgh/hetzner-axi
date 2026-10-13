import { readFileSync } from "node:fs";
import { bool, enumFlag, expectPositionals, flag, flags, intFlag, parseArgs, parseFields, requireFlag, type ParsedArgs } from "../args.js";
import { hcloud, listAll } from "../client.js";
import { axiError, usageError } from "../errors.js";
import { arr, block, countLine, helpBlock, num, obj, out, relTime, str, type Obj } from "../render.js";
import {
  CONFIRM_FLAG,
  findOne,
  formatLabels,
  gb,
  hourlyPrice,
  monthlyPrice,
  parseLabels,
  preview,
  runningHelp,
  settle,
  WAIT_FLAGS,
  waitSeconds,
} from "../resources.js";

export const SERVER_HELP = `usage: hetzner-axi server <subcommand> [args] [flags]
subcommands[15]:
  list, view <server>, types, create, poweron <server>, shutdown <server>, reboot <server>, poweroff <server>, reset <server>, resize <server>, rebuild <server>, delete <server>, label <server>, protect <server>, snapshot <server>
  <server> is a name or numeric id
flags{list}:
  --status <running|off|...>, --label <selector> (e.g. env=prod), --name <exact>, --limit <1-1000> (default 50), --fields <id,ipv6,image,created,labels,private_ip,cores,memory,disk,eur_month,protection>
flags{types}:
  --location <name> (prices and availability there), --arch <x86|arm>, --cpu <shared|dedicated>, --all (include deprecated)
flags{create}:
  --name, --type, --image (required), --location, --ssh-key <name|id> (repeatable), --firewall <name|id> (repeatable), --network <name|id> (repeatable), --label <k=v> (repeatable), --user-data-file <path>, --no-ipv4, --no-ipv6, --stopped, --confirm
flags{shutdown,reboot,poweroff,reset,delete}:
  --confirm (preview without it), --no-wait, --wait <seconds>
flags{resize}:
  --type <name> (required), --upgrade-disk (cannot be downgraded later), --confirm, --no-wait, --wait <seconds>
flags{rebuild}:
  --image <name|id> (required; wipes the disk), --confirm, --no-wait, --wait <seconds>
flags{label}:
  --set <k=v> (repeatable), --remove <key> (repeatable)
flags{protect}:
  --delete <on|off>, --rebuild <on|off>
flags{snapshot}:
  --description <text>, --label <k=v> (repeatable), --no-wait, --wait <seconds> (default 600)
notes:
  Mutations wait for the Hetzner action to finish (default 180s) and are idempotent: powering on a running server or resizing to its current type is a no-op.
  create, shutdown, reboot, poweroff, reset, resize, rebuild and delete preview what they would do until --confirm is given.
examples[6]:
  hetzner-axi server list
  hetzner-axi server view web-1
  hetzner-axi server types --location fsn1
  hetzner-axi server create --name web-2 --type cx22 --image ubuntu-24.04 --location fsn1 --ssh-key laptop --confirm
  hetzner-axi server reboot web-1 --confirm
  hetzner-axi server label web-1 --set env=prod
`;

const SUBCOMMANDS = ["list", "view", "types", "create", "poweron", "shutdown", "reboot", "poweroff", "reset", "resize", "rebuild", "delete", "label", "protect", "snapshot"] as const;
const LIST_FIELDS = ["id", "ipv6", "image", "created", "labels", "private_ip", "cores", "memory", "disk", "eur_month", "protection"] as const;
const STATUSES = ["running", "initializing", "starting", "stopping", "off", "deleting", "migrating", "rebuilding", "unknown"] as const;

export async function serverCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return serverList(rest);
    case "view":
      return serverView(rest);
    case "types":
      return serverTypes(rest);
    case "create":
      return serverCreate(rest);
    case "poweron":
    case "shutdown":
    case "reboot":
    case "poweroff":
    case "reset":
      return serverPower(sub, rest);
    case "resize":
      return serverResize(rest);
    case "rebuild":
      return serverRebuild(rest);
    case "delete":
      return serverDelete(rest);
    case "label":
      return serverLabel(rest);
    case "protect":
      return serverProtect(rest);
    case "snapshot":
      return serverSnapshot(rest);
    default:
      throw usageError(sub ? `unknown server subcommand '${sub}'` : "missing server subcommand", [`subcommands: ${SUBCOMMANDS.join(", ")}`]);
  }
}

// --- read ------------------------------------------------------------------------

export function ipv4(server: Obj): string {
  return str(obj(obj(server["public_net"])["ipv4"])["ip"]) || "none";
}

function ipv6(server: Obj): string {
  return str(obj(obj(server["public_net"])["ipv6"])["ip"]) || "none";
}

function typeName(server: Obj): string {
  return str(obj(server["server_type"])["name"]);
}

function locationName(server: Obj): string {
  return str(obj(server["location"])["name"]) || str(obj(obj(server["datacenter"])["location"])["name"]);
}

function imageName(server: Obj): string {
  const image = obj(server["image"]);
  return str(image["name"]) || str(image["description"]) || (server["image"] ? `image ${num(image["id"])}` : "none");
}

function onOff(value: unknown): string {
  return value === true ? "on" : "off";
}

export function serverRow(server: Obj, extras: readonly string[] = []): Obj {
  const type = obj(server["server_type"]);
  const row: Obj = { name: str(server["name"]), status: str(server["status"]), type: typeName(server), ipv4: ipv4(server), location: locationName(server) };
  for (const field of extras) {
    if (field === "id") row["id"] = num(server["id"]);
    if (field === "ipv6") row["ipv6"] = ipv6(server);
    if (field === "image") row["image"] = imageName(server);
    if (field === "created") row["created"] = relTime(server["created"]);
    if (field === "labels") row["labels"] = formatLabels(server["labels"]);
    if (field === "private_ip") row["private_ip"] = arr(server["private_net"]).map((n) => str(obj(n)["ip"])).filter(Boolean).join("; ") || "none";
    if (field === "cores") row["cores"] = num(type["cores"]);
    if (field === "memory") row["memory"] = num(type["memory"]);
    if (field === "disk") row["disk"] = num(type["disk"]);
    if (field === "eur_month") row["eur_month"] = monthlyPrice(type["prices"], locationName(server)) ?? "unknown";
    if (field === "protection") row["protection"] = `delete ${onOff(obj(server["protection"])["delete"])}; rebuild ${onOff(obj(server["protection"])["rebuild"])}`;
  }
  return row;
}

async function serverList(args: string[]): Promise<string> {
  const command = "hetzner-axi server list";
  const parsed = parseArgs(args, [{ name: "--status" }, { name: "--label" }, { name: "--name" }, { name: "--limit" }, { name: "--fields" }], command);
  expectPositionals(parsed, 0, command);
  const status = flag(parsed, "--status") === undefined ? undefined : enumFlag(parsed, "--status", STATUSES, "running");
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: 1000 });
  const extras = parseFields(flag(parsed, "--fields"), LIST_FIELDS);
  const page = await listAll("/servers", "servers", { status, label_selector: flag(parsed, "--label"), name: flag(parsed, "--name"), sort: "name:asc" }, limit);
  const filtered = Boolean(status ?? flag(parsed, "--label") ?? flag(parsed, "--name"));
  if (page.items.length === 0) {
    return out(block({ servers: filtered ? "0 servers match these filters" : "0 servers in this project" }), helpBlock(["Run `hetzner-axi server create --help` to create one"]));
  }
  const help = ["Run `hetzner-axi server view <name>` for details"];
  if ((page.total ?? 0) > page.items.length) help.unshift(`Run \`${command} --limit ${Math.min(1000, page.total ?? 1000)}\` to see all`);
  if (extras.length === 0) help.push("Add `--fields eur_month,labels` for cost and labels");
  return out(block({ count: countLine(page.items.length, page.total, false), servers: page.items.map((s) => serverRow(s, extras)) }), helpBlock(help));
}

async function serverView(args: string[]): Promise<string> {
  const command = "hetzner-axi server view";
  const parsed = parseArgs(args, [], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <server>`);
  const server = await findOne("servers", "server", ref!);
  const type = obj(server["server_type"]);
  const location = obj(server["location"]);
  const firewallIds = arr(obj(server["public_net"])["firewalls"]).map((f) => num(obj(f)["id"]));
  const volumeIds = arr(server["volumes"]).map(num);
  const [firewalls, volumes] = await Promise.all([
    firewallIds.length > 0 ? listAll("/firewalls", "firewalls", {}, 200).then((p) => p.items) : Promise.resolve([]),
    volumeIds.length > 0 ? listAll("/volumes", "volumes", {}, 200).then((p) => p.items) : Promise.resolve([]),
  ]);
  const names = (items: Obj[], ids: Array<number | undefined>): string =>
    ids.length === 0 ? "none" : ids.map((id) => str(items.find((i) => num(i["id"]) === id)?.["name"]) || `id ${id}`).join("; ");
  const name = str(server["name"]);
  const status = str(server["status"]);
  const outgoing = num(server["outgoing_traffic"]);
  const included = num(server["included_traffic"]);
  const view: Obj = {
    name,
    id: num(server["id"]),
    status,
    type: `${typeName(server)} (${num(type["cores"])} vCPU ${str(type["cpu_type"])} ${str(type["architecture"])}; ${num(type["memory"])} GB RAM; ${num(type["disk"])} GB ${str(type["storage_type"])} disk)`,
    location: `${locationName(server)} (${str(location["city"])} ${str(location["country"])})`,
    image: imageName(server),
    ipv4: ipv4(server),
    ipv6: ipv6(server),
    private_ip: arr(server["private_net"]).map((n) => `${str(obj(n)["ip"])} (network ${num(obj(n)["network"])})`).join("; ") || "none",
    firewalls: names(firewalls, firewallIds),
    volumes: names(volumes, volumeIds),
    labels: formatLabels(server["labels"]),
    protection: `delete ${onOff(obj(server["protection"])["delete"])}; rebuild ${onOff(obj(server["protection"])["rebuild"])}`,
    backups: str(server["backup_window"]) ? `on (window ${str(server["backup_window"])})` : "off",
    eur_month: monthlyPrice(type["prices"], locationName(server)) ?? "unknown",
    traffic_out: outgoing === undefined || !included ? "unknown" : `${Math.round(outgoing / 1e9)} GB of ${Math.round(included / 1e12)} TB included`,
    created: relTime(server["created"]),
  };
  if (server["rescue_enabled"] === true) view["rescue"] = "enabled";
  if (server["locked"] === true) view["locked"] = "yes - an action is running";
  if (type["deprecated"] === true) view["warning"] = `server type ${typeName(server)} is deprecated`;
  const help: string[] = [];
  if (ipv4(server) !== "none") help.push(`Connect with \`ssh root@${ipv4(server)}\``);
  help.push(status === "running" ? `Run \`hetzner-axi server reboot ${name}\` to preview a reboot` : `Run \`hetzner-axi server poweron ${name}\` to start it`);
  return out(block({ server: view }), helpBlock(help));
}

async function serverTypes(args: string[]): Promise<string> {
  const command = "hetzner-axi server types";
  const parsed = parseArgs(args, [{ name: "--location" }, { name: "--arch" }, { name: "--cpu" }, { name: "--all", boolean: true }], command);
  expectPositionals(parsed, 0, command);
  const location = flag(parsed, "--location");
  const arch = flag(parsed, "--arch") === undefined ? undefined : enumFlag(parsed, "--arch", ["x86", "arm"] as const, "x86");
  const cpu = flag(parsed, "--cpu") === undefined ? undefined : enumFlag(parsed, "--cpu", ["shared", "dedicated"] as const, "shared");
  const types = (await listAll("/server_types", "server_types")).items;
  if (location && !types.some((t) => arr(t["prices"]).some((p) => str(obj(p)["location"]) === location))) {
    const known = [...new Set(types.flatMap((t) => arr(t["prices"]).map((p) => str(obj(p)["location"]))))].sort();
    throw usageError(`unknown location '${location}'`, [`locations: ${known.join(", ")}`]);
  }
  const available = (t: Obj): boolean => {
    if (!location) return true;
    const loc = arr(t["locations"]).map(obj).find((l) => str(l["name"]) === location);
    // Older payloads lack `locations`; fall back to having a price there.
    return loc ? loc["available"] !== false && !loc["deprecation"] : arr(t["prices"]).some((p) => str(obj(p)["location"]) === location);
  };
  const rows = types
    .filter((t) => bool(parsed, "--all") || t["deprecated"] !== true)
    .filter((t) => !arch || str(t["architecture"]) === arch)
    .filter((t) => !cpu || str(t["cpu_type"]) === cpu)
    .filter(available)
    .map((t) => ({
      name: str(t["name"]),
      cores: num(t["cores"]),
      memory: num(t["memory"]),
      disk: num(t["disk"]),
      cpu: str(t["cpu_type"]),
      arch: str(t["architecture"]),
      eur_month: monthlyPrice(t["prices"], location) ?? "n/a",
    }))
    .sort((a, b) => (typeof a.eur_month === "number" ? a.eur_month : 1e9) - (typeof b.eur_month === "number" ? b.eur_month : 1e9));
  if (rows.length === 0) return block({ server_types: "0 server types match these filters" });
  return out(
    block({ ...(location ? { location } : { prices: "cheapest location; pass --location for one" }), server_types: rows }),
    helpBlock(["Prices are gross EUR per month (VAT included as configured on the account)", "Run `hetzner-axi server create --help` to create one"]),
  );
}

// --- create ----------------------------------------------------------------------

async function resolveIds(collection: string, key: string, refs: readonly string[]): Promise<Obj[]> {
  return Promise.all(refs.map((ref) => findOne(collection, key, ref, key.replace(/_/g, " "))));
}

async function serverCreate(args: string[]): Promise<string> {
  const command = "hetzner-axi server create";
  const usage = `${command} --name <name> --type <server-type> --image <image> [--location <name>] [--ssh-key <name>] --confirm`;
  const parsed = parseArgs(
    args,
    [
      { name: "--name" },
      { name: "--type" },
      { name: "--image" },
      { name: "--location" },
      { name: "--ssh-key", repeatable: true },
      { name: "--firewall", repeatable: true },
      { name: "--network", repeatable: true },
      { name: "--label", repeatable: true },
      { name: "--user-data-file" },
      { name: "--no-ipv4", boolean: true },
      { name: "--no-ipv6", boolean: true },
      { name: "--stopped", boolean: true },
      CONFIRM_FLAG,
      ...WAIT_FLAGS,
    ],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const name = requireFlag(parsed, "--name", usage);
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/.test(name)) throw usageError(`invalid server name '${name}' - use a hostname (letters, digits, '-' and '.')`);
  const typeRef = requireFlag(parsed, "--type", usage);
  const imageRef = requireFlag(parsed, "--image", usage);
  const location = flag(parsed, "--location");
  const labels = parseLabels(flags(parsed, "--label"));
  const userDataFile = flag(parsed, "--user-data-file");
  const userData = userDataFile === undefined ? undefined : readFileSync(userDataFile === "-" ? 0 : userDataFile, "utf-8");
  if (bool(parsed, "--no-ipv4") && bool(parsed, "--no-ipv6") && flags(parsed, "--network").length === 0) {
    throw usageError("a server without public IPs needs --network, or it is unreachable");
  }
  const seconds = waitSeconds(parsed);

  const existing = arr((await hcloud("/servers", { query: { name } }))["servers"]).map(obj).find((s) => str(s["name"]) === name);
  if (existing) {
    return out(
      block({ server: name, result: "already exists (no-op)", status: str(existing["status"]), type: typeName(existing), ipv4: ipv4(existing) }),
      helpBlock([`Run \`hetzner-axi server view ${name}\``]),
    );
  }

  const types = arr((await hcloud("/server_types", { query: { name: typeRef } }))["server_types"]).map(obj);
  const type = types.find((t) => str(t["name"]) === typeRef);
  if (!type) {
    const all = (await listAll("/server_types", "server_types")).items.filter((t) => t["deprecated"] !== true).map((t) => str(t["name"]));
    throw usageError(`unknown server type '${typeRef}'`, [`server types: ${all.join(", ")}`, "Run `hetzner-axi server types --location <name>` for specs and prices"]);
  }
  const arch = str(type["architecture"]);
  const images = arr((await hcloud("/images", { query: { name: imageRef, architecture: arch } }))["images"]).map(obj);
  const image = /^\d+$/.test(imageRef) ? obj((await hcloud(`/images/${imageRef}`))["image"]) : images.find((i) => str(i["name"]) === imageRef);
  if (!image || !num(image["id"])) {
    throw usageError(`no ${arch} image named '${imageRef}'`, [`Run \`hetzner-axi image list --arch ${arch}\` (snapshots are referenced by id)`]);
  }
  if (str(image["architecture"]) && str(image["architecture"]) !== arch) {
    throw usageError(`image ${imageRef} is ${str(image["architecture"])} but server type ${typeRef} is ${arch}`);
  }
  if (location && !arr(type["prices"]).some((p) => str(obj(p)["location"]) === location)) {
    throw usageError(`server type ${typeRef} is not offered in ${location}`, [`locations: ${arr(type["prices"]).map((p) => str(obj(p)["location"])).join(", ")}`]);
  }
  const [sshKeys, firewalls, networks] = await Promise.all([
    resolveIds("ssh_keys", "ssh_key", flags(parsed, "--ssh-key")),
    resolveIds("firewalls", "firewall", flags(parsed, "--firewall")),
    resolveIds("networks", "network", flags(parsed, "--network")),
  ]);

  const priceAt = location ?? str(obj(arr(type["prices"])[0])["location"]);
  const summary: Obj = {
    name,
    type: `${typeRef} (${num(type["cores"])} vCPU; ${num(type["memory"])} GB RAM; ${num(type["disk"])} GB disk)`,
    image: str(image["name"]) || str(image["description"]),
    location: location ?? "chosen by Hetzner",
    ssh_keys: sshKeys.map((k) => str(k["name"])).join("; ") || "none - a root password is generated and shown once",
    eur_month: monthlyPrice(type["prices"], priceAt) ?? "unknown",
    eur_hour: hourlyPrice(type["prices"], priceAt) ?? "unknown",
  };
  if (firewalls.length > 0) summary["firewalls"] = firewalls.map((f) => str(f["name"])).join("; ");
  if (networks.length > 0) summary["networks"] = networks.map((n) => str(n["name"])).join("; ");
  if (Object.keys(labels).length > 0) summary["labels"] = formatLabels(labels);
  if (!bool(parsed, "--confirm")) {
    return preview(summary, `hetzner-axi server create ${args.filter((a) => a !== "--confirm").map(shellQuote).join(" ")}`, ["Billing starts when the server is created, whether it runs or not"]);
  }

  const body: Obj = {
    name,
    server_type: typeRef,
    image: String(num(image["id"])),
    start_after_create: !bool(parsed, "--stopped"),
    ...(location ? { location } : {}),
    ...(sshKeys.length > 0 ? { ssh_keys: sshKeys.map((k) => String(num(k["id"]))) } : {}),
    ...(firewalls.length > 0 ? { firewalls: firewalls.map((f) => ({ firewall: num(f["id"]) })) } : {}),
    ...(networks.length > 0 ? { networks: networks.map((n) => num(n["id"])) } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(userData !== undefined ? { user_data: userData } : {}),
    public_net: { enable_ipv4: !bool(parsed, "--no-ipv4"), enable_ipv6: !bool(parsed, "--no-ipv6") },
  };
  const created = await hcloud("/servers", { method: "POST", body });
  const server = obj(created["server"]);
  const { result, text } = await settle(created["action"], seconds);
  const response: Obj = { server: name, result: "created", id: num(server["id"]), ipv4: ipv4(server), ipv6: ipv6(server), provisioning: text, eur_month: summary["eur_month"] };
  const password = str(created["root_password"]);
  if (password) response["root_password"] = password;
  const help = [...runningHelp(result), `Run \`hetzner-axi server view ${name}\``];
  if (ipv4(server) !== "none") help.push(`Connect with \`ssh root@${ipv4(server)}\` once it booted`);
  if (password) help.unshift("Store the root password now - Hetzner never shows it again");
  return out(block(response), helpBlock(help));
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

// --- power -----------------------------------------------------------------------

type PowerAction = "poweron" | "shutdown" | "reboot" | "poweroff" | "reset";

const POWER: Record<PowerAction, { confirm: boolean; noopWhen?: string; needs?: string; effect: string }> = {
  poweron: { confirm: false, noopWhen: "running", effect: "starts the server" },
  shutdown: { confirm: true, noopWhen: "off", needs: "running", effect: "sends an ACPI shutdown; the OS stops gracefully" },
  reboot: { confirm: true, needs: "running", effect: "sends an ACPI reboot; the OS restarts gracefully" },
  poweroff: { confirm: true, noopWhen: "off", effect: "cuts power immediately - unsaved data may be lost" },
  reset: { confirm: true, needs: "running", effect: "hard reset like pressing the reset button - unsaved data may be lost" },
};

async function waitForStatus(id: number, want: string, seconds: number): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  const pollMs = Number(process.env["HETZNER_AXI_POLL_MS"] ?? 1000);
  let status = "";
  do {
    status = str(obj((await hcloud(`/servers/${id}`))["server"])["status"]);
    if (status === want) return status;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return status;
}

async function serverPower(action: PowerAction, args: string[]): Promise<string> {
  const command = `hetzner-axi server ${action}`;
  const spec = POWER[action];
  const parsed = parseArgs(args, [...(spec.confirm ? [CONFIRM_FLAG] : []), ...WAIT_FLAGS], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <server>${spec.confirm ? " --confirm" : ""}`);
  const seconds = waitSeconds(parsed);
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  const id = num(server["id"])!;
  const status = str(server["status"]);
  if (spec.noopWhen && status === spec.noopWhen) return block({ server: name, status, result: `already ${status} (no-op)` });
  if (spec.needs && status !== spec.needs) {
    throw usageError(`${name} is ${status}; ${action} needs a ${spec.needs} server`, status === "off" ? [`Run \`hetzner-axi server poweron ${name}\``] : ["Retry once the current action finished"]);
  }
  if (spec.confirm && !bool(parsed, "--confirm")) {
    return preview({ server: name, status, action, effect: spec.effect }, `${command} ${name}`, action === "poweroff" ? [`Prefer \`hetzner-axi server shutdown ${name}\` for a graceful stop`] : []);
  }
  const response = await hcloud(`/servers/${id}/actions/${action}`, { method: "POST" });
  const { result, text } = await settle(response["action"], seconds);
  // A shutdown action succeeds once the ACPI signal is sent; wait for the OS to stop.
  const finalStatus = action === "shutdown" && result.status === "success" && seconds > 0 ? await waitForStatus(id, "off", seconds) : undefined;
  const help = [...runningHelp(result)];
  if (finalStatus && finalStatus !== "off") help.push(`The OS has not stopped yet; run \`hetzner-axi server poweroff ${name} --confirm\` to force it`);
  return out(block({ server: name, result: `${action} ${text}`, ...(finalStatus ? { status: finalStatus } : {}) }), helpBlock(help));
}

// --- resize / rebuild / delete ----------------------------------------------------

async function serverResize(args: string[]): Promise<string> {
  const command = "hetzner-axi server resize";
  const parsed = parseArgs(args, [{ name: "--type" }, { name: "--upgrade-disk", boolean: true }, CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const usage = `${command} <server> --type <server-type> [--upgrade-disk] --confirm`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const typeRef = requireFlag(parsed, "--type", usage);
  const seconds = waitSeconds(parsed, 600);
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  if (typeName(server) === typeRef) return block({ server: name, type: typeRef, result: `already ${typeRef} (no-op)` });
  const type = arr((await hcloud("/server_types", { query: { name: typeRef } }))["server_types"]).map(obj).find((t) => str(t["name"]) === typeRef);
  if (!type) throw usageError(`unknown server type '${typeRef}'`, ["Run `hetzner-axi server types --location <name>`"]);
  const current = obj(server["server_type"]);
  const keepDisk = !bool(parsed, "--upgrade-disk");
  if (keepDisk && (num(type["disk"]) ?? 0) < (num(server["primary_disk_size"]) ?? num(current["disk"]) ?? 0)) {
    throw usageError(`${typeRef} has a smaller disk (${num(type["disk"])} GB) than ${name} uses (${num(server["primary_disk_size"])} GB)`);
  }
  if (str(server["status"]) !== "off") {
    throw usageError(`${name} is ${str(server["status"])}; Hetzner resizes only stopped servers`, [`Run \`hetzner-axi server shutdown ${name} --confirm\` first`]);
  }
  const location = locationName(server);
  if (!bool(parsed, "--confirm")) {
    return preview(
      {
        server: name,
        from: `${typeName(server)} (${num(current["cores"])} vCPU; ${num(current["memory"])} GB; ${gb(current["disk"])})`,
        to: `${typeRef} (${num(type["cores"])} vCPU; ${num(type["memory"])} GB; ${gb(type["disk"])})`,
        disk: keepDisk ? "kept at the current size (the server can be downsized again)" : "upgraded - the server can never move back to a smaller disk",
        eur_month: `${monthlyPrice(current["prices"], location) ?? "?"} -> ${monthlyPrice(type["prices"], location) ?? "?"}`,
      },
      `${command} ${name} --type ${typeRef}${keepDisk ? "" : " --upgrade-disk"}`,
    );
  }
  const response = await hcloud(`/servers/${num(server["id"])}/actions/change_type`, { method: "POST", body: { server_type: typeRef, upgrade_disk: !keepDisk } });
  const { result, text } = await settle(response["action"], seconds);
  return out(block({ server: name, result: `resize to ${typeRef} ${text}` }), helpBlock([...runningHelp(result), `Run \`hetzner-axi server poweron ${name}\` to start it`]));
}

async function serverRebuild(args: string[]): Promise<string> {
  const command = "hetzner-axi server rebuild";
  const parsed = parseArgs(args, [{ name: "--image" }, CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const usage = `${command} <server> --image <name|id> --confirm`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const imageRef = requireFlag(parsed, "--image", usage);
  const seconds = waitSeconds(parsed, 600);
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  if (obj(server["protection"])["rebuild"] === true) {
    throw axiError(`${name} has rebuild protection`, "PROTECTED", [`Run \`hetzner-axi server protect ${name} --rebuild off\` first`]);
  }
  if (!bool(parsed, "--confirm")) {
    return preview({ server: name, image: `${imageName(server)} -> ${imageRef}`, effect: "wipes the disk and installs the image; IPs are kept" }, `${command} ${name} --image ${imageRef}`, [
      `Run \`hetzner-axi server snapshot ${name}\` first to keep a copy`,
    ]);
  }
  const response = await hcloud(`/servers/${num(server["id"])}/actions/rebuild`, { method: "POST", body: { image: imageRef } });
  const { result, text } = await settle(response["action"], seconds);
  const password = str(response["root_password"]);
  return out(
    block({ server: name, result: `rebuild ${text}`, image: imageRef, ...(password ? { root_password: password } : {}) }),
    helpBlock([...(password ? ["Store the root password now - Hetzner never shows it again"] : []), ...runningHelp(result)]),
  );
}

async function serverDelete(args: string[]): Promise<string> {
  const command = "hetzner-axi server delete";
  const parsed = parseArgs(args, [CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <server> --confirm`);
  const seconds = waitSeconds(parsed);
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  if (obj(server["protection"])["delete"] === true) {
    throw axiError(`${name} has delete protection`, "PROTECTED", [`Run \`hetzner-axi server protect ${name} --delete off\` first`]);
  }
  if (!bool(parsed, "--confirm")) {
    const volumes = arr(server["volumes"]).length;
    return preview(
      {
        server: name,
        status: str(server["status"]),
        ipv4: ipv4(server),
        effect: "deletes the server and its disk permanently",
        kept: `${volumes} attached volume${volumes === 1 ? "" : "s"} (detached, not deleted); primary IPs without auto-delete`,
      },
      `${command} ${name}`,
      [`Run \`hetzner-axi server snapshot ${name}\` first to keep a copy`],
    );
  }
  const response = await hcloud(`/servers/${num(server["id"])}`, { method: "DELETE" });
  const { result, text } = await settle(response["action"], seconds);
  return out(block({ server: name, result: `delete ${text}` }), helpBlock(runningHelp(result)));
}

// --- labels / protection / snapshot ------------------------------------------------

export function applyLabelChanges(current: Record<string, string>, parsed: ParsedArgs): { next: Record<string, string>; changed: string[] } {
  const next = { ...current };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parseLabels(flags(parsed, "--set")))) {
    if (next[key] !== value) changed.push(value === "" ? key : `${key}=${value}`);
    next[key] = value;
  }
  for (const key of flags(parsed, "--remove")) {
    if (key in next) {
      delete next[key];
      changed.push(`-${key}`);
    }
  }
  return { next, changed };
}

async function serverLabel(args: string[]): Promise<string> {
  const command = "hetzner-axi server label";
  const parsed = parseArgs(args, [{ name: "--set", repeatable: true }, { name: "--remove", repeatable: true }], command);
  const usage = `${command} <server> --set <k=v> --remove <key>`;
  const [ref] = expectPositionals(parsed, 1, usage);
  if (flags(parsed, "--set").length === 0 && flags(parsed, "--remove").length === 0) throw usageError("nothing to change", [usage]);
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  const current = Object.fromEntries(Object.entries(obj(server["labels"])).map(([k, v]) => [k, String(v)]));
  const { next, changed } = applyLabelChanges(current, parsed);
  if (changed.length === 0) return block({ server: name, labels: formatLabels(current), result: "already up to date (no-op)" });
  await hcloud(`/servers/${num(server["id"])}`, { method: "PUT", body: { labels: next } });
  return block({ server: name, result: "updated", changed: changed.join("; "), labels: formatLabels(next) });
}

async function serverProtect(args: string[]): Promise<string> {
  const command = "hetzner-axi server protect";
  const parsed = parseArgs(args, [{ name: "--delete" }, { name: "--rebuild" }], command);
  const usage = `${command} <server> [--delete on|off] [--rebuild on|off]`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const want: Record<string, boolean> = {};
  for (const key of ["delete", "rebuild"] as const) {
    if (flag(parsed, `--${key}`) !== undefined) want[key] = enumFlag(parsed, `--${key}`, ["on", "off"] as const, "on") === "on";
  }
  if (Object.keys(want).length === 0) throw usageError("nothing to change", [usage]);
  // Hetzner requires rebuild protection to match delete protection.
  if (want["delete"] !== undefined && want["rebuild"] === undefined) want["rebuild"] = want["delete"];
  if (want["rebuild"] !== undefined && want["delete"] === undefined) want["delete"] = want["rebuild"];
  if (want["delete"] !== want["rebuild"]) throw usageError("Hetzner requires --delete and --rebuild protection to be equal");
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  const current = obj(server["protection"]);
  const label = (p: Obj | Record<string, boolean>): string => `delete ${onOff(p["delete"])}; rebuild ${onOff(p["rebuild"])}`;
  if (current["delete"] === want["delete"] && current["rebuild"] === want["rebuild"]) return block({ server: name, protection: label(current), result: "already set (no-op)" });
  const response = await hcloud(`/servers/${num(server["id"])}/actions/change_protection`, { method: "POST", body: want });
  const { text } = await settle(response["action"], 60);
  return block({ server: name, protection: label(want), result: `updated (${text})` });
}

async function serverSnapshot(args: string[]): Promise<string> {
  const command = "hetzner-axi server snapshot";
  const parsed = parseArgs(args, [{ name: "--description" }, { name: "--label", repeatable: true }, ...WAIT_FLAGS], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <server> [--description <text>]`);
  const labels = parseLabels(flags(parsed, "--label"));
  const seconds = waitSeconds(parsed, 600);
  const server = await findOne("servers", "server", ref!);
  const name = str(server["name"]);
  const description = flag(parsed, "--description") ?? `${name} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const response = await hcloud(`/servers/${num(server["id"])}/actions/create_image`, {
    method: "POST",
    body: { type: "snapshot", description, ...(Object.keys(labels).length > 0 ? { labels } : {}) },
  });
  const image = obj(response["image"]);
  const { result, text } = await settle(response["action"], seconds);
  return out(
    block({ server: name, result: `snapshot ${text}`, image_id: num(image["id"]), description }),
    helpBlock([...runningHelp(result), "Snapshots are billed per GB-month; `hetzner-axi image list --type snapshot` lists them"]),
  );
}
