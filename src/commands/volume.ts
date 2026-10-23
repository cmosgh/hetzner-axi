import { bool, enumFlag, expectPositionals, flag, flags, parseArgs, parseFields, requireFlag } from "../args.js";
import { hcloud, listAll } from "../client.js";
import { axiError, usageError } from "../errors.js";
import { arr, block, extraFields, helpBlock, num, obj, out, str, type Fields, type Obj } from "../render.js";
import { CONFIRM_FLAG, findOne, formatLabels, parseLabels, preview, runningHelp, settle, WAIT_FLAGS, waitSeconds } from "../resources.js";

/** `volume list` extras; the default row is name, size_gb, server, location. */
const LIST_FIELDS: Fields = {
  device: (v) => str(v["linux_device"]),
  id: (v) => num(v["id"]),
};

export const VOLUME_HELP = `usage: hetzner-axi volume <subcommand> [args] [flags]
subcommands[6]:
  list, create, attach <volume>, detach <volume>, resize <volume>, delete <volume>
flags{list}:
  --fields <${Object.keys(LIST_FIELDS).join(",")}>
flags{create}:
  --name, --size <GB 10-10240> (required), --location <name> | --server <name|id> (attach right away), --format <ext4|xfs>, --automount, --label <k=v> (repeatable), --confirm
flags{attach}:
  --server <name|id> (required), --automount
flags{resize}:
  --size <GB> (grow only), --confirm
flags{detach,delete}:
  --confirm
notes:
  Volumes are billed per GB-month; create and resize preview the cost until --confirm. Resizing only grows a volume - grow the filesystem afterwards (resize2fs / xfs_growfs).
examples[4]:
  hetzner-axi volume list
  hetzner-axi volume create --name data --size 50 --server web-1 --format ext4 --automount --confirm
  hetzner-axi volume resize data --size 100 --confirm
  hetzner-axi volume detach data --confirm
`;

export async function volumeCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return volumeList(rest);
    case "create":
      return volumeCreate(rest);
    case "attach":
      return volumeAttach(rest);
    case "detach":
      return volumeDetach(rest);
    case "resize":
      return volumeResize(rest);
    case "delete":
      return volumeDelete(rest);
    default:
      throw usageError(sub ? `unknown volume subcommand '${sub}'` : "missing volume subcommand", ["subcommands: list, create, attach, detach, resize, delete"]);
  }
}

async function serverNames(): Promise<Map<number, string>> {
  const { items } = await listAll("/servers", "servers", {}, 1000);
  return new Map(items.map((s) => [num(s["id"]) ?? 0, str(s["name"])]));
}

async function volumePrice(size: number): Promise<number | undefined> {
  const pricing = obj((await hcloud("/pricing"))["pricing"]);
  const perGb = Number(str(obj(obj(pricing["volume"])["price_per_gb_month"])["gross"]));
  return Number.isFinite(perGb) ? Math.round(perGb * size * 100) / 100 : undefined;
}

async function volumeList(args: string[]): Promise<string> {
  const command = "hetzner-axi volume list";
  const parsed = parseArgs(args, [{ name: "--fields" }], command);
  expectPositionals(parsed, 0, command);
  const extras = parseFields(flag(parsed, "--fields"), Object.keys(LIST_FIELDS));
  const { items } = await listAll("/volumes", "volumes", { sort: "name:asc" });
  if (items.length === 0) return out(block({ volumes: "0 volumes in this project" }), helpBlock(["Run `hetzner-axi volume create --help`"]));
  const names = items.some((v) => num(v["server"])) ? await serverNames() : new Map<number, string>();
  return block({
    volumes: items.map((v) => ({
      name: str(v["name"]),
      size_gb: num(v["size"]),
      server: num(v["server"]) ? (names.get(num(v["server"])!) ?? `id ${num(v["server"])}`) : "detached",
      location: str(obj(v["location"])["name"]),
      ...extraFields(v, extras, LIST_FIELDS),
    })),
  });
}

function sizeFlag(raw: string | undefined, usage: string): number {
  if (raw === undefined) throw usageError("--size is required", [usage]);
  if (!/^\d+$/.test(raw) || Number(raw) < 10 || Number(raw) > 10240) throw usageError(`--size must be whole GB between 10 and 10240, got '${raw}'`);
  return Number(raw);
}

async function volumeCreate(args: string[]): Promise<string> {
  const command = "hetzner-axi volume create";
  const usage = `${command} --name <name> --size <GB> (--location <name> | --server <name>) --confirm`;
  const parsed = parseArgs(
    args,
    [{ name: "--name" }, { name: "--size" }, { name: "--location" }, { name: "--server" }, { name: "--format" }, { name: "--automount", boolean: true }, { name: "--label", repeatable: true }, CONFIRM_FLAG, ...WAIT_FLAGS],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const name = requireFlag(parsed, "--name", usage);
  const size = sizeFlag(flag(parsed, "--size"), usage);
  const location = flag(parsed, "--location");
  const serverRef = flag(parsed, "--server");
  if ((location === undefined) === (serverRef === undefined)) throw usageError("pass exactly one of --location or --server", [usage]);
  const format = flag(parsed, "--format") === undefined ? undefined : enumFlag(parsed, "--format", ["ext4", "xfs"] as const, "ext4");
  if (bool(parsed, "--automount") && (!serverRef || !format)) throw usageError("--automount needs --server and --format");
  const labels = parseLabels(flags(parsed, "--label"));
  const seconds = waitSeconds(parsed);

  const existing = arr((await hcloud("/volumes", { query: { name } }))["volumes"]).map(obj).find((v) => str(v["name"]) === name);
  if (existing) return block({ volume: name, result: "already exists (no-op)", size_gb: num(existing["size"]), location: str(obj(existing["location"])["name"]) });
  const server = serverRef ? await findOne("servers", "server", serverRef) : undefined;
  const summary: Obj = {
    name,
    size_gb: size,
    location: location ?? str(obj(server?.["location"])["name"]),
    server: server ? str(server["name"]) : "none (detached)",
    format: format ?? "none (unformatted)",
    eur_month: (await volumePrice(size)) ?? "unknown",
  };
  if (!bool(parsed, "--confirm")) return preview(summary, `${command} ${args.filter((a) => a !== "--confirm").join(" ")}`);
  const created = await hcloud("/volumes", {
    method: "POST",
    body: {
      name,
      size,
      ...(location ? { location } : { server: num(server!["id"]) }),
      ...(format ? { format } : {}),
      ...(bool(parsed, "--automount") ? { automount: true } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    },
  });
  const volume = obj(created["volume"]);
  const { result, text } = await settle(created["action"], seconds);
  for (const next of arr(created["next_actions"])) await settle(next, seconds);
  return out(
    block({ volume: name, result: `created (${text})`, id: num(volume["id"]), device: str(volume["linux_device"]), eur_month: summary["eur_month"] }),
    helpBlock([...runningHelp(result), ...(server && !bool(parsed, "--automount") ? [`Mount it on ${str(server["name"])}: mkdir -p /mnt/${name} && mount ${str(volume["linux_device"])} /mnt/${name}`] : [])]),
  );
}

async function volumeAttach(args: string[]): Promise<string> {
  const command = "hetzner-axi volume attach";
  const parsed = parseArgs(args, [{ name: "--server" }, { name: "--automount", boolean: true }, ...WAIT_FLAGS], command);
  const usage = `${command} <volume> --server <name|id>`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const serverRef = requireFlag(parsed, "--server", usage);
  const [volume, server] = await Promise.all([findOne("volumes", "volume", ref!), findOne("servers", "server", serverRef)]);
  const name = str(volume["name"]);
  if (num(volume["server"]) === num(server["id"])) return block({ volume: name, server: str(server["name"]), result: "already attached (no-op)" });
  if (num(volume["server"])) throw usageError(`${name} is attached to server ${num(volume["server"])}`, [`Run \`hetzner-axi volume detach ${name} --confirm\` first`]);
  if (str(obj(volume["location"])["name"]) !== str(obj(server["location"])["name"])) {
    throw usageError(`${name} is in ${str(obj(volume["location"])["name"])} but ${str(server["name"])} is in ${str(obj(server["location"])["name"])}`);
  }
  const response = await hcloud(`/volumes/${num(volume["id"])}/actions/attach`, { method: "POST", body: { server: num(server["id"]), automount: bool(parsed, "--automount") } });
  const { result, text } = await settle(response["action"], waitSeconds(parsed));
  return out(block({ volume: name, server: str(server["name"]), result: `attach ${text}`, device: str(volume["linux_device"]) }), helpBlock(runningHelp(result)));
}

async function volumeDetach(args: string[]): Promise<string> {
  const command = "hetzner-axi volume detach";
  const parsed = parseArgs(args, [CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <volume> --confirm`);
  const volume = await findOne("volumes", "volume", ref!);
  const name = str(volume["name"]);
  if (!num(volume["server"])) return block({ volume: name, result: "already detached (no-op)" });
  if (!bool(parsed, "--confirm")) {
    return preview({ volume: name, server: num(volume["server"]), effect: "detaches the block device; unmount it on the server first" }, `${command} ${name}`);
  }
  const response = await hcloud(`/volumes/${num(volume["id"])}/actions/detach`, { method: "POST" });
  const { result, text } = await settle(response["action"], waitSeconds(parsed));
  return out(block({ volume: name, result: `detach ${text}` }), helpBlock(runningHelp(result)));
}

async function volumeResize(args: string[]): Promise<string> {
  const command = "hetzner-axi volume resize";
  const parsed = parseArgs(args, [{ name: "--size" }, CONFIRM_FLAG, ...WAIT_FLAGS], command);
  const usage = `${command} <volume> --size <GB> --confirm`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const size = sizeFlag(flag(parsed, "--size"), usage);
  const volume = await findOne("volumes", "volume", ref!);
  const name = str(volume["name"]);
  const current = num(volume["size"]) ?? 0;
  if (size === current) return block({ volume: name, size_gb: current, result: "already this size (no-op)" });
  if (size < current) throw usageError(`volumes only grow; ${name} is ${current} GB`);
  if (!bool(parsed, "--confirm")) {
    return preview({ volume: name, size_gb: `${current} -> ${size}`, eur_month: `${(await volumePrice(current)) ?? "?"} -> ${(await volumePrice(size)) ?? "?"}`, effect: "cannot be shrunk again" }, `${command} ${name} --size ${size}`);
  }
  const response = await hcloud(`/volumes/${num(volume["id"])}/actions/resize`, { method: "POST", body: { size } });
  const { result, text } = await settle(response["action"], waitSeconds(parsed));
  return out(block({ volume: name, result: `resize to ${size} GB ${text}` }), helpBlock([...runningHelp(result), "Grow the filesystem on the server: resize2fs <device> (ext4) or xfs_growfs <mountpoint> (xfs)"]));
}

async function volumeDelete(args: string[]): Promise<string> {
  const command = "hetzner-axi volume delete";
  const parsed = parseArgs(args, [CONFIRM_FLAG], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <volume> --confirm`);
  const volume = await findOne("volumes", "volume", ref!);
  const name = str(volume["name"]);
  if (num(volume["server"])) throw usageError(`${name} is still attached`, [`Run \`hetzner-axi volume detach ${name} --confirm\` first`]);
  if (obj(volume["protection"])["delete"] === true) throw axiError(`${name} has delete protection`, "PROTECTED");
  if (!bool(parsed, "--confirm")) return preview({ volume: name, size_gb: num(volume["size"]), labels: formatLabels(volume["labels"]), effect: "deletes the volume and its data permanently" }, `${command} ${name}`);
  await hcloud(`/volumes/${num(volume["id"])}`, { method: "DELETE" });
  return block({ volume: name, result: "deleted" });
}

