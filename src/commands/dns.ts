import { bool, expectPositionals, flag, flags, intFlag, parseArgs, requireFlag } from "../args.js";
import { hcloud, listAll } from "../client.js";
import { axiError, usageError } from "../errors.js";
import { arr, block, helpBlock, num, obj, out, relTime, rerunCommand, str, type Obj } from "../render.js";
import { CONFIRM_FLAG, preview, protectionOffHint, settle } from "../resources.js";

export const DNS_HELP = `usage: hetzner-axi dns <zone|record> <subcommand> [args] [flags]
subcommands[8]:
  zone list, zone view <zone>, zone create --name <domain>, zone delete <zone>
  record list <zone>, record set <zone> <name> <TYPE>, record add <zone> <name> <TYPE>, record remove <zone> <name> <TYPE>
  <name> is relative to the zone: @ for the apex, www, or a full name (www.example.com)
flags{record list}:
  --type <A|AAAA|CNAME|MX|TXT|...>, --name <name>
flags{record set,record add}:
  --record <value> (repeatable, required), --ttl <seconds>
flags{record remove}:
  --record <value> (repeatable; omit to remove the whole record set), --confirm
flags{record set}:
  --confirm (needed only when it replaces existing values)
flags{zone create}:
  --name <domain> (required), --ttl <seconds>
flags{zone delete}:
  --confirm
notes:
  DNS zones live in the Hetzner Cloud API (Cloud Console - DNS); the legacy dns.hetzner.com API is not used.
  TXT values are quoted and split into 255-character strings for you. MX values are '<priority> <host>'.
  set replaces a record set's values, add appends to them; both are no-ops when nothing changes.
examples[5]:
  hetzner-axi dns zone list
  hetzner-axi dns record list example.com --type A
  hetzner-axi dns record set example.com www A --record 203.0.113.10 --ttl 300
  hetzner-axi dns record add example.com @ TXT --record 'v=spf1 include:_spf.example.net ~all'
  hetzner-axi dns record remove example.com old CNAME --confirm
`;

const TYPES = ["A", "AAAA", "CAA", "CNAME", "DS", "HINFO", "HTTPS", "MX", "NS", "PTR", "RP", "SOA", "SRV", "SVCB", "TLSA", "TXT"] as const;

/** Quote and chunk a TXT value like hcloud-go's FormatTXTRecord; quoted input is kept. */
export function formatTxt(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) return value;
  const escaped = value.replace(/"/g, '\\"');
  const parts: string[] = [];
  for (let i = 0; i < escaped.length; i += 255) parts.push(`"${escaped.slice(i, i + 255)}"`);
  return parts.length === 0 ? '""' : parts.join(" ");
}

/** Join quoted TXT strings back into one plain value for display and comparison. */
export function parseTxt(value: string): string {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const c of value) {
    if (escaped) {
      current += c;
      escaped = false;
    } else if (c === "\\") escaped = true;
    else if (c === '"') quoted = !quoted;
    else if (c === " " && !quoted) {
      if (current) parts.push(current);
      current = "";
    } else current += c;
  }
  if (current) parts.push(current);
  return parts.join("");
}

export function recordName(raw: string, zone: string): string {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (name === "" || name === "@" || name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

function recordType(raw: string): (typeof TYPES)[number] {
  const type = raw.toUpperCase();
  if (!(TYPES as readonly string[]).includes(type)) throw usageError(`unknown record type '${raw}'`, [`types: ${TYPES.join(", ")}`]);
  return type as (typeof TYPES)[number];
}

/** `@` stays literal in rrset paths, as in Hetzner's docs. */
function rrPath(name: string): string {
  return encodeURIComponent(name).replace(/%40/g, "@");
}

function display(type: string, value: string): string {
  return type === "TXT" ? parseTxt(value) : value;
}

function zoneName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

async function findZone(ref: string): Promise<Obj> {
  try {
    return obj((await hcloud(`/zones/${encodeURIComponent(zoneName(ref))}`))["zone"]);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "NOT_FOUND") {
      const zones = (await listAll("/zones", "zones", {}, 100)).items.map((z) => str(z["name"]));
      throw axiError(`no DNS zone '${ref}' in this project`, "NOT_FOUND", [zones.length > 0 ? `zones: ${zones.join(", ")}` : "0 zones in this project", "Run `hetzner-axi dns zone create --name <domain>`"]);
    }
    throw error;
  }
}

export async function dnsCommand(args: string[]): Promise<string> {
  const [group, sub, ...rest] = args;
  if (group === "zone") {
    if (sub === "list") return zoneList(rest);
    if (sub === "view") return zoneView(rest);
    if (sub === "create") return zoneCreate(rest);
    if (sub === "delete") return zoneDelete(rest);
    throw usageError(sub ? `unknown dns zone subcommand '${sub}'` : "missing dns zone subcommand", ["subcommands: list, view, create, delete"]);
  }
  if (group === "record") {
    if (sub === "list") return recordList(rest);
    if (sub === "set" || sub === "add") return recordWrite(sub, rest);
    if (sub === "remove") return recordRemove(rest);
    throw usageError(sub ? `unknown dns record subcommand '${sub}'` : "missing dns record subcommand", ["subcommands: list, set, add, remove"]);
  }
  throw usageError(group ? `unknown dns group '${group}'` : "missing dns group", ["Run `hetzner-axi dns zone list` or `hetzner-axi dns record list <zone>`"]);
}

// --- zones -------------------------------------------------------------------------

async function zoneList(args: string[]): Promise<string> {
  const command = "hetzner-axi dns zone list";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const { items } = await listAll("/zones", "zones", { sort: "name:asc" });
  if (items.length === 0) return out(block({ zones: "0 DNS zones in this project" }), helpBlock(["Run `hetzner-axi dns zone create --name <domain>`"]));
  return out(
    block({
      zones: items.map((z) => ({ name: str(z["name"]), records: num(z["record_count"]), ttl: num(z["ttl"]), delegation: str(obj(z["authoritative_nameservers"])["delegation_status"]) || "unknown" })),
    }),
    helpBlock(["Run `hetzner-axi dns record list <zone>` for its records"]),
  );
}

async function zoneView(args: string[]): Promise<string> {
  const command = "hetzner-axi dns zone view";
  const [ref] = expectPositionals(parseArgs(args, [], command), 1, `${command} <zone>`);
  const zone = await findZone(ref!);
  const ns = obj(zone["authoritative_nameservers"]);
  const delegation = str(ns["delegation_status"]);
  const help = [`Run \`hetzner-axi dns record list ${str(zone["name"])}\``];
  if (delegation && delegation !== "valid") help.unshift(`Set these nameservers at the registrar: ${arr(ns["assigned"]).map(str).join(" ")}`);
  return out(
    block({
      zone: {
        name: str(zone["name"]),
        id: num(zone["id"]),
        mode: str(zone["mode"]),
        status: str(zone["status"]),
        ttl: num(zone["ttl"]),
        records: num(zone["record_count"]),
        nameservers: arr(ns["assigned"]).map(str).join(" ") || "unknown",
        delegation: delegation || "unknown",
        delegation_checked: ns["delegation_last_check"] ? relTime(ns["delegation_last_check"]) : "never",
        protection: obj(zone["protection"])["delete"] === true ? "delete on" : "delete off",
        created: relTime(zone["created"]),
      },
    }),
    helpBlock(help),
  );
}

async function zoneCreate(args: string[]): Promise<string> {
  const command = "hetzner-axi dns zone create";
  const parsed = parseArgs(args, [{ name: "--name" }, { name: "--ttl" }], command);
  const usage = `${command} --name <domain> [--ttl <seconds>]`;
  expectPositionals(parsed, 0, usage);
  const name = zoneName(requireFlag(parsed, "--name", usage));
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(name)) throw usageError(`invalid domain '${name}' (use punycode for IDNs, e.g. xn--mnchen-3ya.de)`);
  const ttl = flag(parsed, "--ttl") === undefined ? undefined : intFlag(parsed, "--ttl", 3600, { min: 60, max: 2147483647 });
  const existing = (await listAll("/zones", "zones", { name }, 5)).items.find((z) => str(z["name"]) === name);
  if (existing) return block({ zone: name, result: "already exists (no-op)", records: num(existing["record_count"]) });
  const created = await hcloud("/zones", { method: "POST", body: { name, mode: "primary", ...(ttl ? { ttl } : {}) } });
  await settle(created["action"], 60);
  const zone = obj(created["zone"]);
  const assigned = arr(obj(zone["authoritative_nameservers"])["assigned"]).map(str);
  return out(
    block({ zone: name, result: "created", nameservers: assigned.join(" ") || "see zone view" }),
    helpBlock([`Point the domain's nameservers at the registrar to ${assigned.length > 0 ? assigned.join(" ") : "the assigned ones"}`, `Run \`hetzner-axi dns record set ${name} @ A --record <ip>\``]),
  );
}

async function zoneDelete(args: string[]): Promise<string> {
  const command = "hetzner-axi dns zone delete";
  const parsed = parseArgs(args, [CONFIRM_FLAG], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <zone> --confirm`);
  const zone = await findZone(ref!);
  const name = str(zone["name"]);
  if (obj(zone["protection"])["delete"] === true) throw axiError(`${name} has delete protection`, "PROTECTED", [protectionOffHint(`/zones/${num(zone["id"])}`)]);
  if (!bool(parsed, "--confirm")) return preview({ zone: name, records: num(zone["record_count"]), effect: "deletes the zone and every record; the domain stops resolving if delegated here" }, rerunCommand(command, args));
  const response = await hcloud(`/zones/${num(zone["id"])}`, { method: "DELETE" });
  await settle(response["action"], 60);
  return block({ zone: name, result: "deleted" });
}

// --- records -----------------------------------------------------------------------

function rrsetRow(rrset: Obj): Obj {
  const type = str(rrset["type"]);
  return {
    name: str(rrset["name"]),
    type,
    ttl: num(rrset["ttl"]) ?? "zone default",
    values: arr(rrset["records"]).map((r) => display(type, str(obj(r)["value"]))).join(" | "),
  };
}

async function recordList(args: string[]): Promise<string> {
  const command = "hetzner-axi dns record list";
  const parsed = parseArgs(args, [{ name: "--type" }, { name: "--name" }], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <zone> [--type <TYPE>] [--name <name>]`);
  const zone = await findZone(ref!);
  const name = str(zone["name"]);
  const type = flag(parsed, "--type") === undefined ? undefined : recordType(flag(parsed, "--type")!);
  const rrName = flag(parsed, "--name") === undefined ? undefined : recordName(flag(parsed, "--name")!, name);
  const { items } = await listAll(`/zones/${num(zone["id"])}/rrsets`, "rrsets", { type, name: rrName, sort: "name:asc" });
  if (items.length === 0) return block({ zone: name, records: type || rrName ? "0 record sets match these filters" : "0 record sets" });
  return out(block({ zone: name, records: items.map(rrsetRow) }), helpBlock([`Run \`hetzner-axi dns record set ${name} <name> <TYPE> --record <value>\` to change one`]));
}

async function getRrset(zoneId: number, name: string, type: string): Promise<Obj | undefined> {
  try {
    return obj((await hcloud(`/zones/${zoneId}/rrsets/${rrPath(name)}/${type}`))["rrset"]);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "NOT_FOUND") return undefined;
    throw error;
  }
}

function values(type: string, raw: readonly string[]): string[] {
  const formatted = raw.map((v) => (type === "TXT" ? formatTxt(v) : v.trim()));
  return [...new Set(formatted)];
}

function sameValue(type: string, a: string, b: string): boolean {
  return type === "TXT" ? parseTxt(a) === parseTxt(b) : a.toLowerCase() === b.toLowerCase();
}

async function recordWrite(sub: "set" | "add", args: string[]): Promise<string> {
  const command = `hetzner-axi dns record ${sub}`;
  const parsed = parseArgs(args, [{ name: "--record", repeatable: true }, { name: "--ttl" }, ...(sub === "set" ? [CONFIRM_FLAG] : [])], command);
  const usage = `${command} <zone> <name> <TYPE> --record <value> [--ttl <seconds>]`;
  const [zoneRef, rawName, rawType] = expectPositionals(parsed, 3, usage);
  const type = recordType(rawType!);
  const wanted = values(type, flags(parsed, "--record"));
  if (wanted.length === 0) throw usageError("--record is required", [usage]);
  if (type === "CNAME" && wanted.length > 1) throw usageError("a CNAME record set holds exactly one value");
  const ttl = flag(parsed, "--ttl") === undefined ? undefined : intFlag(parsed, "--ttl", 3600, { min: 60, max: 2147483647 });
  const zone = await findZone(zoneRef!);
  const zoneId = num(zone["id"])!;
  const zname = str(zone["name"]);
  const name = recordName(rawName!, zname);
  const label = `${name === "@" ? zname : `${name}.${zname}`} ${type}`;
  const existing = await getRrset(zoneId, name, type);

  if (!existing) {
    const created = await hcloud(`/zones/${zoneId}/rrsets`, { method: "POST", body: { name, type, records: wanted.map((value) => ({ value })), ...(ttl ? { ttl } : {}) } });
    await settle(created["action"], 60);
    return block({ record: label, result: "created", values: wanted.map((v) => display(type, v)).join(" | "), ttl: ttl ?? "zone default" });
  }

  const current = arr(existing["records"]).map((r) => str(obj(r)["value"]));
  const missing = wanted.filter((w) => !current.some((c) => sameValue(type, c, w)));
  const extra = current.filter((c) => !wanted.some((w) => sameValue(type, c, w)));
  const ttlChange = ttl !== undefined && ttl !== num(existing["ttl"]);
  const valuesChange = sub === "add" ? missing.length > 0 : missing.length > 0 || extra.length > 0;
  if (!valuesChange && !ttlChange) return block({ record: label, values: current.map((v) => display(type, v)).join(" | "), result: "already up to date (no-op)" });
  if (sub === "set" && extra.length > 0 && !bool(parsed, "--confirm")) {
    return preview(
      { record: label, from: current.map((v) => display(type, v)).join(" | "), to: wanted.map((v) => display(type, v)).join(" | "), ...(ttlChange ? { ttl: `${num(existing["ttl"]) ?? "zone default"} -> ${ttl}` } : {}) },
      rerunCommand(command, args),
      [`Run \`${rerunCommand("hetzner-axi dns record add", args)}\` instead to keep the existing values`],
    );
  }
  const path = `/zones/${zoneId}/rrsets/${rrPath(name)}/${type}/actions`;
  if (ttlChange) await settle((await hcloud(`${path}/change_ttl`, { method: "POST", body: { ttl } }))["action"], 60);
  if (valuesChange) {
    const response =
      sub === "add"
        ? await hcloud(`${path}/add_records`, { method: "POST", body: { records: missing.map((value) => ({ value })) } })
        : await hcloud(`${path}/set_records`, { method: "POST", body: { records: wanted.map((value) => ({ value })) } });
    await settle(response["action"], 60);
  }
  const final = sub === "add" ? [...current, ...missing] : wanted;
  return block({ record: label, result: "updated", values: final.map((v) => display(type, v)).join(" | "), ...(ttlChange ? { ttl } : {}) });
}

async function recordRemove(args: string[]): Promise<string> {
  const command = "hetzner-axi dns record remove";
  const parsed = parseArgs(args, [{ name: "--record", repeatable: true }, CONFIRM_FLAG], command);
  const usage = `${command} <zone> <name> <TYPE> [--record <value>] --confirm`;
  const [zoneRef, rawName, rawType] = expectPositionals(parsed, 3, usage);
  const type = recordType(rawType!);
  const remove = values(type, flags(parsed, "--record"));
  const zone = await findZone(zoneRef!);
  const zoneId = num(zone["id"])!;
  const zname = str(zone["name"]);
  const name = recordName(rawName!, zname);
  const label = `${name === "@" ? zname : `${name}.${zname}`} ${type}`;
  const existing = await getRrset(zoneId, name, type);
  if (!existing) return block({ record: label, result: "no such record set (no-op)" });
  const current = arr(existing["records"]).map((r) => str(obj(r)["value"]));
  const matched = remove.length === 0 ? current : current.filter((c) => remove.some((r) => sameValue(type, c, r)));
  if (matched.length === 0) return block({ record: label, values: current.map((v) => display(type, v)).join(" | "), result: "none of these values are present (no-op)" });
  const whole = matched.length === current.length;
  if (!bool(parsed, "--confirm")) {
    return preview({ record: label, remove: matched.map((v) => display(type, v)).join(" | "), effect: whole ? "deletes the whole record set" : `keeps ${current.length - matched.length} other value(s)` }, rerunCommand(command, args));
  }
  const path = `/zones/${zoneId}/rrsets/${rrPath(name)}/${type}`;
  const response = whole ? await hcloud(path, { method: "DELETE" }) : await hcloud(`${path}/actions/remove_records`, { method: "POST", body: { records: matched.map((value) => ({ value })) } });
  await settle(response["action"], 60);
  return block({ record: label, result: whole ? "record set deleted" : `removed ${matched.length} value(s)` });
}
