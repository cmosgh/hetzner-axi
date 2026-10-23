import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { bool, enumFlag, expectPositionals, flag, intFlag, parseArgs } from "../args.js";
import { hcloud, listAll } from "../client.js";
import { AxiError, usageError } from "../errors.js";
import { arr, block, countLine, helpBlock, num, obj, out, relTime, str } from "../render.js";
import { CONFIRM_FLAG, findOne, formatLabels, parseLabels, preview } from "../resources.js";

export const IMAGE_HELP = `usage: hetzner-axi image <list|delete> [flags]
flags{list}:
  --type <system|snapshot|backup|app> (default system), --arch <x86|arm>, --label <selector>, --all (include deprecated), --limit <1-1000> (default 100)
flags{delete}:
  <id> --confirm (snapshots and backups only)
examples[3]:
  hetzner-axi image list
  hetzner-axi image list --type snapshot
  hetzner-axi image delete 4711 --confirm
`;

export const LOCATION_HELP = `usage: hetzner-axi location list
Hetzner Cloud locations with their network zone.
`;

export async function imageCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "list") return imageList(rest);
  if (sub === "delete") return imageDelete(rest);
  throw usageError(sub ? `unknown image subcommand '${sub}'` : "missing image subcommand", ["subcommands: list, delete"]);
}

async function imageList(args: string[]): Promise<string> {
  const command = "hetzner-axi image list";
  const parsed = parseArgs(args, [{ name: "--type" }, { name: "--arch" }, { name: "--label" }, { name: "--all", boolean: true }, { name: "--limit" }], command);
  expectPositionals(parsed, 0, command);
  const type = enumFlag(parsed, "--type", ["system", "snapshot", "backup", "app"] as const, "system");
  const arch = flag(parsed, "--arch") === undefined ? undefined : enumFlag(parsed, "--arch", ["x86", "arm"] as const, "x86");
  const limit = intFlag(parsed, "--limit", 100, { min: 1, max: 1000 });
  const page = await listAll(
    "/images",
    "images",
    { type, architecture: arch, label_selector: flag(parsed, "--label"), include_deprecated: bool(parsed, "--all") ? "true" : undefined, sort: type === "system" ? "name:asc" : "created:desc" },
    limit,
  );
  if (page.items.length === 0) return block({ images: `0 ${type} images` });
  const custom = type === "snapshot" || type === "backup";
  const rows = page.items.map((i) =>
    custom
      ? { id: num(i["id"]), description: str(i["description"]), size_gb: Math.round((num(i["image_size"]) ?? 0) * 100) / 100, from: str(obj(i["created_from"])["name"]) || "unknown", created: relTime(i["created"]) }
      : { name: str(i["name"]), arch: str(i["architecture"]), os: `${str(i["os_flavor"])} ${str(i["os_version"])}`.trim(), ...(i["deprecated"] ? { deprecated: "yes" } : {}) },
  );
  return out(
    block({ type, count: countLine(rows.length, page.total, false), images: rows }),
    helpBlock([custom ? "Use the id with `hetzner-axi server create --image <id>`" : "Use the name with `hetzner-axi server create --image <name>`"]),
  );
}

async function imageDelete(args: string[]): Promise<string> {
  const command = "hetzner-axi image delete";
  const parsed = parseArgs(args, [CONFIRM_FLAG], command);
  const [id] = expectPositionals(parsed, 1, `${command} <id> --confirm`);
  if (!/^\d+$/.test(id!)) throw usageError("image delete takes a numeric snapshot or backup id", ["Run `hetzner-axi image list --type snapshot`"]);
  const image = obj((await hcloud(`/images/${id}`))["image"]);
  const type = str(image["type"]);
  if (type !== "snapshot" && type !== "backup") throw usageError(`image ${id} is a ${type} image; only snapshots and backups can be deleted`);
  if (!bool(parsed, "--confirm")) {
    return preview({ image: num(image["id"]), type, description: str(image["description"]), effect: "deletes the image permanently" }, `${command} ${id}`);
  }
  await hcloud(`/images/${id}`, { method: "DELETE" });
  return block({ image: num(image["id"]), result: "deleted" });
}

export async function locationCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "list") throw usageError(sub ? `unknown location subcommand '${sub}'` : "missing location subcommand", ["subcommands: list"]);
  const command = "hetzner-axi location list";
  expectPositionals(parseArgs(rest, [], command), 0, command);
  const { items } = await listAll("/locations", "locations");
  return block({
    locations: items.map((l) => ({ name: str(l["name"]), city: str(l["city"]), country: str(l["country"]), network_zone: str(l["network_zone"]) })),
  });
}

// --- ssh keys ----------------------------------------------------------------------

export const SSH_KEY_HELP = `usage: hetzner-axi ssh-key <list|add|delete> [args] [flags]
flags{add}:
  --name <name> (required), --public-key <key> | --public-key-file <path> (e.g. ~/.ssh/id_ed25519.pub), --label <k=v> (repeatable)
flags{delete}:
  <name|id> --confirm
notes:
  add is a no-op when the same public key is already stored (under any name).
examples[3]:
  hetzner-axi ssh-key list
  hetzner-axi ssh-key add --name laptop --public-key-file ~/.ssh/id_ed25519.pub
  hetzner-axi ssh-key delete old-laptop --confirm
`;

/** Compare keys by type and key material, ignoring the trailing comment. */
export function keyMaterial(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

export async function sshKeyCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const command = "hetzner-axi ssh-key list";
    expectPositionals(parseArgs(rest, [], command), 0, command);
    const { items } = await listAll("/ssh_keys", "ssh_keys", { sort: "name:asc" });
    if (items.length === 0) return out(block({ ssh_keys: "0 ssh keys in this project" }), helpBlock(["Run `hetzner-axi ssh-key add --name <name> --public-key-file ~/.ssh/id_ed25519.pub`"]));
    return block({ ssh_keys: items.map((k) => ({ name: str(k["name"]), fingerprint: str(k["fingerprint"]), created: relTime(k["created"]) })) });
  }
  if (sub === "add") return sshKeyAdd(rest);
  if (sub === "delete") {
    const command = "hetzner-axi ssh-key delete";
    const parsed = parseArgs(rest, [CONFIRM_FLAG], command);
    const [ref] = expectPositionals(parsed, 1, `${command} <name|id> --confirm`);
    const key = await findOne("ssh_keys", "ssh_key", ref!, "ssh key");
    if (!bool(parsed, "--confirm")) return preview({ ssh_key: str(key["name"]), fingerprint: str(key["fingerprint"]), effect: "removes the key from the project; existing servers keep it" }, `${command} ${str(key["name"])}`);
    await hcloud(`/ssh_keys/${num(key["id"])}`, { method: "DELETE" });
    return block({ ssh_key: str(key["name"]), result: "deleted" });
  }
  throw usageError(sub ? `unknown ssh-key subcommand '${sub}'` : "missing ssh-key subcommand", ["subcommands: list, add, delete"]);
}

async function sshKeyAdd(args: string[]): Promise<string> {
  const command = "hetzner-axi ssh-key add";
  const usage = `${command} --name <name> --public-key-file <path>`;
  const parsed = parseArgs(args, [{ name: "--name" }, { name: "--public-key" }, { name: "--public-key-file" }, { name: "--label", repeatable: true }], command);
  expectPositionals(parsed, 0, usage);
  const name = flag(parsed, "--name");
  if (!name) throw usageError("--name is required", [usage]);
  const inline = flag(parsed, "--public-key");
  const file = flag(parsed, "--public-key-file");
  if ((inline === undefined) === (file === undefined)) throw usageError("pass exactly one of --public-key or --public-key-file", [usage]);
  const publicKey = (inline ?? readFileSync(file!.replace(/^~(?=\/)/, homedir()), "utf-8")).trim();
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+[A-Za-z0-9+/=]+/.test(publicKey)) {
    throw usageError("that is not an OpenSSH public key", ["Pass the .pub file, never the private key"]);
  }
  const labels = parseLabels(parsed.values.get("--label") ?? []);
  const existing = (await listAll("/ssh_keys", "ssh_keys")).items;
  const same = existing.find((k) => keyMaterial(str(k["public_key"])) === keyMaterial(publicKey));
  if (same) return block({ ssh_key: str(same["name"]), fingerprint: str(same["fingerprint"]), result: "this public key is already stored (no-op)" });
  if (existing.some((k) => str(k["name"]) === name)) throw usageError(`another key is already named '${name}'`, ["Pick a different --name"]);
  const created = obj((await hcloud("/ssh_keys", { method: "POST", body: { name, public_key: publicKey, ...(Object.keys(labels).length > 0 ? { labels } : {}) } }))["ssh_key"]);
  return out(block({ ssh_key: name, fingerprint: str(created["fingerprint"]), result: "added" }), helpBlock([`Use it with \`hetzner-axi server create ... --ssh-key ${name}\``]));
}

// --- networks / load balancers / actions (read) -----------------------------------

export const NETWORK_HELP = `usage: hetzner-axi network list
Private networks with their IP range, subnets and attached servers.
`;

export async function networkCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "list") throw usageError(sub ? `unknown network subcommand '${sub}'` : "missing network subcommand", ["subcommands: list"]);
  const command = "hetzner-axi network list";
  expectPositionals(parseArgs(rest, [], command), 0, command);
  const { items } = await listAll("/networks", "networks", { sort: "name:asc" });
  if (items.length === 0) return block({ networks: "0 networks in this project" });
  return block({
    networks: items.map((n) => ({
      name: str(n["name"]),
      ip_range: str(n["ip_range"]),
      subnets: arr(n["subnets"]).map((s) => `${str(obj(s)["ip_range"])} ${str(obj(s)["network_zone"])}`).join("; ") || "none",
      servers: arr(n["servers"]).length,
    })),
  });
}

export const LB_HELP = `usage: hetzner-axi lb <list|view> [<name|id>]
Load balancers with their services and target health (read-only).
`;

export async function lbCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const command = "hetzner-axi lb list";
    expectPositionals(parseArgs(rest, [], command), 0, command);
    const { items } = await listAll("/load_balancers", "load_balancers", { sort: "name:asc" });
    if (items.length === 0) return block({ load_balancers: "0 load balancers in this project" });
    return out(
      block({
        load_balancers: items.map((lb) => ({
          name: str(lb["name"]),
          type: str(obj(lb["load_balancer_type"])["name"]),
          ipv4: str(obj(obj(lb["public_net"])["ipv4"])["ip"]) || "none",
          location: str(obj(lb["location"])["name"]),
          targets: targetHealth(lb),
        })),
      }),
      helpBlock(["Run `hetzner-axi lb view <name>` for services and per-target health"]),
    );
  }
  if (sub === "view") {
    const command = "hetzner-axi lb view";
    const [ref] = expectPositionals(parseArgs(rest, [], command), 1, `${command} <name|id>`);
    const lb = await findOne("load_balancers", "load_balancer", ref!, "load balancer");
    return block({
      load_balancer: {
        name: str(lb["name"]),
        id: num(lb["id"]),
        type: str(obj(lb["load_balancer_type"])["name"]),
        ipv4: str(obj(obj(lb["public_net"])["ipv4"])["ip"]) || "none",
        location: str(obj(lb["location"])["name"]),
        algorithm: str(obj(lb["algorithm"])["type"]),
        labels: formatLabels(lb["labels"]),
        services: arr(lb["services"]).map(obj).map((s) => ({ protocol: str(s["protocol"]), listen: num(s["listen_port"]), destination: num(s["destination_port"]) })),
        targets: arr(lb["targets"]).map(obj).map((t) => ({
          target: str(t["type"]) === "server" ? `server ${num(obj(t["server"])["id"])}` : str(t["type"]) === "ip" ? str(obj(t["ip"])["ip"]) : `label ${str(obj(t["label_selector"])["selector"])}`,
          health: arr(t["health_status"]).map((h) => `${num(obj(h)["listen_port"])} ${str(obj(h)["status"])}`).join("; ") || "unknown",
        })),
      },
    });
  }
  throw usageError(sub ? `unknown lb subcommand '${sub}'` : "missing lb subcommand", ["subcommands: list, view"]);
}

function targetHealth(lb: Record<string, unknown>): string {
  const statuses = arr(lb["targets"]).flatMap((t) => arr(obj(t)["health_status"]).map((h) => str(obj(h)["status"])));
  if (statuses.length === 0) return `${arr(lb["targets"]).length} targets`;
  const healthy = statuses.filter((s) => s === "healthy").length;
  return `${healthy}/${statuses.length} healthy`;
}

const ACTION_COLLECTIONS = ["servers", "volumes", "floating_ips", "primary_ips", "firewalls", "networks", "load_balancers", "images", "zones"];

export const ACTION_HELP = `usage: hetzner-axi action <list|view> [<id>] [flags]
Hetzner runs changes as asynchronous actions; mutations wait for them, --no-wait returns early.
flags{list}:
  --running (only running), --limit <1-100> (default 20)
examples[2]:
  hetzner-axi action list --running
  hetzner-axi action view 4711
`;

export async function actionCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const command = "hetzner-axi action list";
    const parsed = parseArgs(rest, [{ name: "--running", boolean: true }, { name: "--limit" }], command);
    expectPositionals(parsed, 0, command);
    const limit = intFlag(parsed, "--limit", 20, { min: 1, max: 100 });
    const status = bool(parsed, "--running") ? "running" : undefined;
    const lists = await Promise.all(
      ACTION_COLLECTIONS.map((collection) =>
        listAll(`/${collection}/actions`, "actions", { sort: "started:desc", status }, limit).then(
          (p) => p.items,
          (error: unknown) => {
            // A collection the API does not serve has no actions; any other failure (token, network) is the answer.
            if (error instanceof AxiError && error.code === "NOT_FOUND") return [];
            throw error;
          },
        ),
      ),
    );
    const actions = lists
      .flat()
      .sort((a, b) => str(b["started"]).localeCompare(str(a["started"])))
      .slice(0, limit);
    if (actions.length === 0) return block({ actions: bool(parsed, "--running") ? "0 running actions" : "0 actions" });
    return block({
      actions: actions.map((a) => ({
        id: num(a["id"]),
        command: str(a["command"]),
        status: str(a["status"]),
        resource: arr(a["resources"]).map((r) => `${str(obj(r)["type"])} ${num(obj(r)["id"])}`).join("; "),
        started: relTime(a["started"]),
      })),
    });
  }
  if (sub === "view") {
    const command = "hetzner-axi action view";
    const [id] = expectPositionals(parseArgs(rest, [], command), 1, `${command} <id>`);
    if (!/^\d+$/.test(id!)) throw usageError("action ids are numeric");
    const action = obj((await hcloud(`/actions/${id}`))["action"]);
    const error = obj(action["error"]);
    return block({
      action: {
        id: num(action["id"]),
        command: str(action["command"]),
        status: str(action["status"]),
        progress: num(action["progress"]),
        started: relTime(action["started"]),
        finished: action["finished"] ? relTime(action["finished"]) : "not yet",
        resources: arr(action["resources"]).map((r) => `${str(obj(r)["type"])} ${num(obj(r)["id"])}`).join("; "),
        ...(str(error["message"]) ? { error: `${str(error["code"])} - ${str(error["message"])}` } : {}),
      },
    });
  }
  throw usageError(sub ? `unknown action subcommand '${sub}'` : "missing action subcommand", ["subcommands: list, view"]);
}

