import { bool, enumFlag, expectPositionals, flag, flags, parseArgs, requireFlag, type ParsedArgs } from "../args.js";
import { hcloud, listAll } from "../client.js";
import { usageError } from "../errors.js";
import { arr, block, helpBlock, num, obj, out, rerunCommand, shellQuote, str, type Obj } from "../render.js";
import { CONFIRM_FLAG, findOne, formatLabels, preview, settle } from "../resources.js";

export const FIREWALL_HELP = `usage: hetzner-axi firewall <subcommand> [args] [flags]
subcommands[8]:
  list, view <firewall>, create, add-rule <firewall>, remove-rule <firewall>, apply <firewall>, remove-from <firewall>, delete <firewall>
flags{create}:
  --name <name> (required)
flags{add-rule,remove-rule}:
  --direction <in|out> (default in), --protocol <tcp|udp|icmp|esp|gre> (required), --port <22|8000-8100|any> (tcp/udp), --source-ip <cidr|any> (repeatable; in), --destination-ip <cidr|any> (repeatable; out), --description <text> (add-rule), --confirm
flags{apply,remove-from}:
  --server <name|id> | --label <selector>, --confirm
flags{delete}:
  --confirm
notes:
  'any' means 0.0.0.0/0 and ::/0. Rule changes replace the firewall's rule set atomically and are no-ops when the rule already exists (add) or is absent (remove).
  Every change that can open or cut traffic previews until --confirm.
examples[4]:
  hetzner-axi firewall view web
  hetzner-axi firewall add-rule web --protocol tcp --port 443 --source-ip any --confirm
  hetzner-axi firewall remove-rule web --protocol tcp --port 22 --source-ip any --confirm
  hetzner-axi firewall apply web --server web-2 --confirm
`;

const ANY = ["0.0.0.0/0", "::/0"];

export async function firewallCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return firewallList(rest);
    case "view":
      return firewallView(rest);
    case "create":
      return firewallCreate(rest);
    case "add-rule":
    case "remove-rule":
      return firewallRule(sub, rest);
    case "apply":
    case "remove-from":
      return firewallApply(sub, rest);
    case "delete":
      return firewallDelete(rest);
    default:
      throw usageError(sub ? `unknown firewall subcommand '${sub}'` : "missing firewall subcommand", [
        "subcommands: list, view, create, add-rule, remove-rule, apply, remove-from, delete",
      ]);
  }
}

export interface Rule {
  direction: "in" | "out";
  protocol: string;
  port: string | null;
  source_ips: string[];
  destination_ips: string[];
  description?: string | null;
}

export function normalizeRule(raw: Obj): Rule {
  return {
    direction: str(raw["direction"]) === "out" ? "out" : "in",
    protocol: str(raw["protocol"]),
    port: str(raw["port"]) || null,
    source_ips: arr(raw["source_ips"]).map(str).sort(),
    destination_ips: arr(raw["destination_ips"]).map(str).sort(),
    description: str(raw["description"]) || null,
  };
}

export function sameRule(a: Rule, b: Rule): boolean {
  return (
    a.direction === b.direction &&
    a.protocol === b.protocol &&
    (a.port ?? "") === (b.port ?? "") &&
    a.source_ips.join(" ") === b.source_ips.join(" ") &&
    a.destination_ips.join(" ") === b.destination_ips.join(" ")
  );
}

function ips(values: readonly string[]): string[] {
  const out = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean).flatMap((v) => (v === "any" ? ANY : [v.includes("/") ? v : `${v}/${v.includes(":") ? 128 : 32}`]));
  return [...new Set(out)].sort();
}

function ruleText(rule: Rule): string {
  const peers = rule.direction === "in" ? rule.source_ips : rule.destination_ips;
  const who = peers.join(" ") === ANY.join(" ") ? "any" : peers.join(" ");
  return `${rule.direction} ${rule.protocol}${rule.port ? ` ${rule.port}` : ""} ${rule.direction === "in" ? "from" : "to"} ${who}`;
}

export function ruleFromFlags(parsed: ParsedArgs, usage: string): Rule {
  const direction = enumFlag(parsed, "--direction", ["in", "out"] as const, "in");
  const protocol = enumFlag(parsed, "--protocol", ["tcp", "udp", "icmp", "esp", "gre"] as const, "tcp");
  if (flag(parsed, "--protocol") === undefined) throw usageError("--protocol is required", [usage]);
  const rawPort = flag(parsed, "--port");
  const ported = protocol === "tcp" || protocol === "udp";
  if (ported && rawPort === undefined) throw usageError(`--port is required for ${protocol} (a port, a range like 8000-8100, or any)`, [usage]);
  if (!ported && rawPort !== undefined) throw usageError(`--port does not apply to ${protocol}`);
  const port = rawPort === undefined ? null : rawPort === "any" ? "1-65535" : rawPort;
  if (port && !/^\d{1,5}(-\d{1,5})?$/.test(port)) throw usageError(`invalid --port '${rawPort}'`);
  const source = ips(flags(parsed, "--source-ip"));
  const destination = ips(flags(parsed, "--destination-ip"));
  if (direction === "in" && (source.length === 0 || destination.length > 0)) throw usageError("inbound rules take --source-ip (use 'any' for everyone) and no --destination-ip", [usage]);
  if (direction === "out" && (destination.length === 0 || source.length > 0)) throw usageError("outbound rules take --destination-ip (use 'any') and no --source-ip", [usage]);
  return { direction, protocol, port, source_ips: source, destination_ips: destination, description: flag(parsed, "--description") ?? null };
}

function appliedTo(firewall: Obj, names: Map<number, string>): string {
  const targets = arr(firewall["applied_to"]).map(obj).map((a) =>
    str(a["type"]) === "server" ? (names.get(num(obj(a["server"])["id"]) ?? 0) ?? `server ${num(obj(a["server"])["id"])}`) : `label ${str(obj(a["label_selector"])["selector"])}`,
  );
  return targets.join("; ") || "nothing";
}

async function serverNames(): Promise<Map<number, string>> {
  const { items } = await listAll("/servers", "servers", {}, 1000);
  return new Map(items.map((s) => [num(s["id"]) ?? 0, str(s["name"])]));
}

async function firewallList(args: string[]): Promise<string> {
  const command = "hetzner-axi firewall list";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const { items } = await listAll("/firewalls", "firewalls", { sort: "name:asc" });
  if (items.length === 0) return out(block({ firewalls: "0 firewalls in this project" }), helpBlock(["Run `hetzner-axi firewall create --name <name>`"]));
  const names = await serverNames();
  return out(
    block({ firewalls: items.map((f) => ({ name: str(f["name"]), rules: arr(f["rules"]).length, applied_to: appliedTo(f, names) })) }),
    helpBlock(["Run `hetzner-axi firewall view <name>` for its rules"]),
  );
}

async function firewallView(args: string[]): Promise<string> {
  const command = "hetzner-axi firewall view";
  const [ref] = expectPositionals(parseArgs(args, [], command), 1, `${command} <firewall>`);
  const [firewall, names] = await Promise.all([findOne("firewalls", "firewall", ref!), serverNames()]);
  const rules = arr(firewall["rules"]).map(obj).map(normalizeRule);
  return out(
    block({
      firewall: {
        name: str(firewall["name"]),
        id: num(firewall["id"]),
        applied_to: appliedTo(firewall, names),
        labels: formatLabels(firewall["labels"]),
        rules:
          rules.length === 0
            ? "0 rules - all inbound traffic is blocked once applied"
            : rules.map((r) => ({
                direction: r.direction,
                protocol: r.protocol,
                port: r.port ?? "n/a",
                ips: (r.direction === "in" ? r.source_ips : r.destination_ips).join(" ") === ANY.join(" ") ? "any" : (r.direction === "in" ? r.source_ips : r.destination_ips).join(" "),
                description: r.description ?? "",
              })),
      },
    }),
    helpBlock(["Outbound traffic is allowed unless an out rule exists", `Run \`hetzner-axi firewall add-rule ${shellQuote(str(firewall["name"]))} --help\` to change rules`]),
  );
}

async function firewallCreate(args: string[]): Promise<string> {
  const command = "hetzner-axi firewall create";
  const parsed = parseArgs(args, [{ name: "--name" }], command);
  const usage = `${command} --name <name>`;
  expectPositionals(parsed, 0, usage);
  const name = requireFlag(parsed, "--name", usage);
  const existing = arr((await hcloud("/firewalls", { query: { name } }))["firewalls"]).map(obj).find((f) => str(f["name"]) === name);
  if (existing) return block({ firewall: name, result: "already exists (no-op)", rules: arr(existing["rules"]).length });
  await hcloud("/firewalls", { method: "POST", body: { name } });
  return out(block({ firewall: name, result: "created with 0 rules" }), helpBlock([`Run \`hetzner-axi firewall add-rule ${shellQuote(name)} --protocol tcp --port 22 --source-ip any --confirm\` before applying it`]));
}

async function firewallRule(sub: "add-rule" | "remove-rule", args: string[]): Promise<string> {
  const command = `hetzner-axi firewall ${sub}`;
  const parsed = parseArgs(
    args,
    [{ name: "--direction" }, { name: "--protocol" }, { name: "--port" }, { name: "--source-ip", repeatable: true }, { name: "--destination-ip", repeatable: true }, ...(sub === "add-rule" ? [{ name: "--description" }] : []), CONFIRM_FLAG],
    command,
  );
  const usage = `${command} <firewall> --protocol <tcp|udp|icmp> --port <port> --source-ip <cidr|any> --confirm`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const rule = ruleFromFlags(parsed, usage);
  const firewall = await findOne("firewalls", "firewall", ref!);
  const name = str(firewall["name"]);
  const rules = arr(firewall["rules"]).map(obj).map(normalizeRule);
  const present = rules.some((r) => sameRule(r, rule));
  if (sub === "add-rule" && present) return block({ firewall: name, rule: ruleText(rule), result: "rule already present (no-op)" });
  if (sub === "remove-rule" && !present) {
    return out(block({ firewall: name, rule: ruleText(rule), result: "no such rule (no-op)" }), helpBlock([`Run \`hetzner-axi firewall view ${shellQuote(name)}\` to see the exact rules`]));
  }
  const next = sub === "add-rule" ? [...rules, rule] : rules.filter((r) => !sameRule(r, rule));
  if (!bool(parsed, "--confirm")) {
    return preview({ firewall: name, change: `${sub === "add-rule" ? "add" : "remove"} ${ruleText(rule)}`, rules: `${rules.length} -> ${next.length}`, applied_to: arr(firewall["applied_to"]).length }, rerunCommand(command, args));
  }
  const body = next.map((r) => ({
    direction: r.direction,
    protocol: r.protocol,
    ...(r.port ? { port: r.port } : {}),
    ...(r.direction === "in" ? { source_ips: r.source_ips } : { destination_ips: r.destination_ips }),
    ...(r.description ? { description: r.description } : {}),
  }));
  const response = await hcloud(`/firewalls/${num(firewall["id"])}/actions/set_rules`, { method: "POST", body: { rules: body } });
  for (const action of arr(response["actions"])) await settle(action, 120);
  return block({ firewall: name, result: `${sub === "add-rule" ? "added" : "removed"} ${ruleText(rule)}`, rules: next.length });
}

async function firewallApply(sub: "apply" | "remove-from", args: string[]): Promise<string> {
  const command = `hetzner-axi firewall ${sub}`;
  const parsed = parseArgs(args, [{ name: "--server" }, { name: "--label" }, CONFIRM_FLAG], command);
  const usage = `${command} <firewall> (--server <name|id> | --label <selector>) --confirm`;
  const [ref] = expectPositionals(parsed, 1, usage);
  const serverRef = flag(parsed, "--server");
  const selector = flag(parsed, "--label");
  if ((serverRef === undefined) === (selector === undefined)) throw usageError("pass exactly one of --server or --label", [usage]);
  const [firewall, server] = await Promise.all([findOne("firewalls", "firewall", ref!), serverRef ? findOne("servers", "server", serverRef) : Promise.resolve(undefined)]);
  const name = str(firewall["name"]);
  const target = server ? { type: "server", server: { id: num(server["id"]) } } : { type: "label_selector", label_selector: { selector } };
  const targetText = server ? `server ${str(server["name"])}` : `label ${selector}`;
  const applied = arr(firewall["applied_to"]).map(obj).some((a) =>
    server ? str(a["type"]) === "server" && num(obj(a["server"])["id"]) === num(server["id"]) : str(a["type"]) === "label_selector" && str(obj(a["label_selector"])["selector"]) === selector,
  );
  if (sub === "apply" && applied) return block({ firewall: name, target: targetText, result: "already applied (no-op)" });
  if (sub === "remove-from" && !applied) return block({ firewall: name, target: targetText, result: "not applied there (no-op)" });
  if (!bool(parsed, "--confirm")) {
    const rules = arr(firewall["rules"]).length;
    return preview(
      {
        firewall: name,
        target: targetText,
        effect: sub === "apply" ? `inbound traffic is limited to the firewall's ${rules} rule${rules === 1 ? "" : "s"}` : "the firewall's rules stop filtering traffic to this target",
      },
      rerunCommand(command, args),
      sub === "apply" && !arr(firewall["rules"]).map(obj).some((r) => str(r["port"]) === "22") ? ["Warning: no rule allows SSH (port 22)"] : [],
    );
  }
  const response = await hcloud(`/firewalls/${num(firewall["id"])}/actions/${sub === "apply" ? "apply_to_resources" : "remove_from_resources"}`, {
    method: "POST",
    body: { [sub === "apply" ? "apply_to" : "remove_from"]: [target] },
  });
  for (const action of arr(response["actions"])) await settle(action, 120);
  return block({ firewall: name, target: targetText, result: sub === "apply" ? "applied" : "removed" });
}

async function firewallDelete(args: string[]): Promise<string> {
  const command = "hetzner-axi firewall delete";
  const parsed = parseArgs(args, [CONFIRM_FLAG], command);
  const [ref] = expectPositionals(parsed, 1, `${command} <firewall> --confirm`);
  const firewall = await findOne("firewalls", "firewall", ref!);
  const name = str(firewall["name"]);
  if (arr(firewall["applied_to"]).length > 0) throw usageError(`${name} is still applied`, [`Run \`hetzner-axi firewall view ${shellQuote(name)}\` and remove it from each target first`]);
  if (!bool(parsed, "--confirm")) return preview({ firewall: name, rules: arr(firewall["rules"]).length, effect: "deletes the firewall" }, `${command} ${shellQuote(name)}`);
  await hcloud(`/firewalls/${num(firewall["id"])}`, { method: "DELETE" });
  return block({ firewall: name, result: "deleted" });
}
