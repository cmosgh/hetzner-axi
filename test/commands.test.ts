import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import { clearToken, storeToken } from "../src/credentials.js";
import { CX22, CX32, done, mockApi, page, run, running, server, useTestEnv } from "./helpers.js";

// Stands in for the OS keychain so no test can reach the real one; records every entry opened.
const keychain = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(service: string, account: string) {
      keychain.opened.push(`${service}/${account}`);
    }
    getPassword(): string | null {
      return null;
    }
    setPassword(): void {}
    deletePassword(): boolean {
      return false;
    }
  },
}));

beforeEach(() => {
  useTestEnv();
  keychain.opened.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const byName = (name: string, item: unknown) => ({ path: "/servers", reply: (c: { url: URL }) => ({ json: page("servers", c.url.searchParams.get("name") === name || !c.url.searchParams.get("name") ? [item] : []) }) });

describe("home", () => {
  it("makes no request until configured", async () => {
    delete process.env["HCLOUD_TOKEN"];
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hetzner: not configured");
    expect(calls).toHaveLength(0);
  });

  it("summarises servers with not-running ones first", async () => {
    mockApi([{ path: "/servers", json: page("servers", [server("web-1"), server("db-1", { id: 43, status: "off" })]) }]);
    const { stdout } = await run();
    expect(stdout).toContain("server_count: 2 (1 running; 1 off)");
    expect(stdout).toContain("servers[2]{name,status,type,ipv4}:");
    expect(stdout.indexOf("db-1")).toBeLessThan(stdout.indexOf("web-1"));
  });
});

describe("server list and view", () => {
  it("lists four default fields and extras by --fields", async () => {
    const { calls } = mockApi([{ path: "/servers", json: page("servers", [server("web-1", { labels: { env: "prod" } })]) }]);
    const plain = (await run("server", "list")).stdout;
    expect(plain).toContain("servers[1]{name,status,type,ipv4}:\n  web-1,running,cx22,203.0.113.10\n");
    // A complete count is a number, not a quoted string.
    expect(plain).toMatch(/^count: 1$/m);
    const { stdout } = await run("server", "list", "--label", "env=prod", "--fields", "location,eur_month,labels");
    expect(calls[1]!.url.searchParams.get("label_selector")).toBe("env=prod");
    expect(stdout).toContain("servers[1]{name,status,type,ipv4,location,eur_month,labels}:");
    expect(stdout).toContain("web-1,running,cx22,203.0.113.10,fsn1,4.51,env=prod");
  });

  it("suggests --limit and --fields reruns that keep the filters", async () => {
    mockApi([{ path: "/servers", json: { servers: [server("web-1")], meta: { pagination: { page: 1, per_page: 1, next_page: 2, last_page: 3, total_entries: 3 } } } }]);
    const { stdout } = await run("server", "list", "--status", "running", "--limit", "1");
    expect(stdout).toMatch(/^count: 1 of 3 total$/m);
    expect(stdout).toContain("Run `hetzner-axi server list --status running --limit 3` to see all");
    expect(stdout).toContain("Run `hetzner-axi server list --status running --limit 1 --fields eur_month,labels` for cost and labels");
  });

  it("rejects an unknown --fields value before any request", async () => {
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run("server", "list", "--fields", "cost");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("available --fields");
    expect(calls).toHaveLength(0);
  });

  it("resolves by name and suggests close names on a miss", async () => {
    mockApi([{ path: "/servers", reply: (c) => ({ json: page("servers", c.url.searchParams.get("name") ? [] : [server("web-1"), server("web-2", { id: 2 })]) }) }]);
    const { stdout, exitCode } = await run("server", "view", "web");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: NOT_FOUND");
    expect(stdout).toContain("did you mean: web-1, web-2");
  });

  it("shows spec, price, firewall names and an ssh hint", async () => {
    mockApi([
      byName("web-1", server("web-1", { public_net: { ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8::/64" }, firewalls: [{ id: 9 }] } })),
      { path: "/firewalls", json: page("firewalls", [{ id: 9, name: "web" }]) },
    ]);
    const { stdout } = await run("server", "view", "web-1");
    expect(stdout).toContain("type: cx22 (2 vCPU shared x86; 4 GB RAM; 40 GB local disk)");
    expect(stdout).toContain("firewalls: web");
    expect(stdout).toContain("eur_month: 4.51");
    expect(stdout).toContain("ssh root@203.0.113.10");
  });
});

describe("server create", () => {
  const routes = () => [
    { path: "/servers", json: page("servers", []) },
    { path: "/server_types", json: page("server_types", [CX22]) },
    { path: "/images", json: page("images", [{ id: 7, name: "ubuntu-24.04", architecture: "x86" }]) },
    { path: "/ssh_keys", json: page("ssh_keys", [{ id: 5, name: "laptop" }]) },
  ];

  it("previews with the price and sends nothing without --confirm", async () => {
    const { calls } = mockApi(routes());
    const { stdout, exitCode } = await run("server", "create", "--name", "web-2", "--type", "cx22", "--image", "ubuntu-24.04", "--location", "fsn1", "--ssh-key", "laptop");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("result: NOT executed - add --confirm");
    expect(stdout).toContain("eur_month: 4.51");
    expect(stdout).toContain("--ssh-key laptop --confirm");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("creates with ids, waits for the action and shows a one-time root password", async () => {
    const { calls } = mockApi([
      ...routes(),
      { method: "POST", path: "/servers", json: { server: server("web-2", { status: "initializing" }), action: running(11, "create_server"), root_password: "s3cret" } },
      { path: "/actions/11", json: { action: done(11, "create_server") } },
    ]);
    const { stdout } = await run("server", "create", "--name", "web-2", "--type", "cx22", "--image", "ubuntu-24.04", "--location", "fsn1", "--confirm");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ name: "web-2", server_type: "cx22", image: "7", location: "fsn1", start_after_create: true });
    expect(stdout).toContain("result: created");
    expect(stdout).toContain("provisioning: done");
    expect(stdout).toContain("root_password: s3cret");
    expect(stdout).toContain("never shows it again");
  });

  it("refuses an unreadable --user-data-file before any request", async () => {
    const { calls } = mockApi(routes());
    const missing = join(mkdtempSync(join(tmpdir(), "hetzner-axi-test-")), "cloud-init.yml");
    const { stdout, exitCode } = await run("server", "create", "--name", "web-2", "--type", "cx22", "--image", "ubuntu-24.04", "--user-data-file", missing);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("code: VALIDATION_ERROR");
    expect(stdout).toContain(`cannot read --user-data-file '${missing}' - no such file or directory`);
    expect(calls).toHaveLength(0);
  });

  it("sends the --user-data-file contents", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hetzner-axi-test-")), "cloud-init.yml");
    writeFileSync(file, "#cloud-config\npackages: [nginx]\n");
    const { calls } = mockApi([
      ...routes(),
      { method: "POST", path: "/servers", json: { server: server("web-2"), action: done(11, "create_server") } },
    ]);
    await run("server", "create", "--name", "web-2", "--type", "cx22", "--image", "ubuntu-24.04", "--user-data-file", file, "--confirm");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ user_data: "#cloud-config\npackages: [nginx]\n" });
  });

  it("is a no-op when a server with that name exists", async () => {
    const { calls } = mockApi([{ path: "/servers", json: page("servers", [server("web-2")]) }]);
    const { stdout } = await run("server", "create", "--name", "web-2", "--type", "cx22", "--image", "ubuntu-24.04", "--confirm");
    expect(stdout).toContain("already exists (no-op)");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("lists valid server types for an unknown one", async () => {
    mockApi([{ path: "/servers", json: page("servers", []) }, { path: "/server_types", reply: (c) => ({ json: page("server_types", c.url.searchParams.get("name") ? [] : [CX22, CX32]) }) }]);
    const { stdout, exitCode } = await run("server", "create", "--name", "x", "--type", "cx99", "--image", "ubuntu-24.04");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("server types: cx22, cx32");
  });
});

describe("server power and lifecycle", () => {
  it("poweron of a running server is a no-op", async () => {
    const { calls } = mockApi([byName("web-1", server("web-1"))]);
    const { stdout } = await run("server", "poweron", "web-1");
    expect(stdout).toContain("already running (no-op)");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reboot previews, then posts and waits with --confirm", async () => {
    const { calls } = mockApi([
      byName("web-1", server("web-1")),
      { method: "POST", path: "/servers/42/actions/reboot", json: { action: running(3, "reboot_server") } },
      { path: "/actions/3", json: { action: done(3, "reboot_server") } },
    ]);
    expect((await run("server", "reboot", "web-1")).stdout).toContain("NOT executed");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const { stdout } = await run("server", "reboot", "web-1", "--confirm");
    expect(stdout).toContain("result: reboot done");
  });

  it("reports a failed action as ACTION_FAILED", async () => {
    mockApi([
      byName("web-1", server("web-1")),
      { method: "POST", path: "/servers/42/actions/reset", json: { action: { id: 4, command: "reset_server", status: "error", error: { code: "x", message: "host error" } } } },
    ]);
    const { stdout, exitCode } = await run("server", "reset", "web-1", "--confirm");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: ACTION_FAILED");
    expect(stdout).toContain("host error");
  });

  it("resize requires a stopped server and is a no-op for the current type", async () => {
    mockApi([byName("web-1", server("web-1")), { path: "/server_types", json: page("server_types", [CX32]) }]);
    expect((await run("server", "resize", "web-1", "--type", "cx22")).stdout).toContain("already cx22 (no-op)");
    const { stdout, exitCode } = await run("server", "resize", "web-1", "--type", "cx32");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("server shutdown web-1 --confirm");
  });

  it("previews repeat the exact command, --wait and --no-wait included", async () => {
    const { calls } = mockApi([
      { path: "/servers", reply: (c) => ({ json: page("servers", [server("web-1"), server("db-1", { id: 43, status: "off" })].filter((s) => s["name"] === c.url.searchParams.get("name"))) }) },
      { path: "/servers/42", json: { server: server("web-1") } },
      { path: "/server_types", json: page("server_types", [CX32]) },
      { path: "/volumes", json: page("volumes", [{ id: 6, name: "data", size: 50, server: 42, location: { name: "fsn1" } }]) },
      { path: "/pricing", json: { pricing: { volume: { price_per_gb_month: { gross: "0.0524" } } } } },
      { path: "/floating_ips", json: page("floating_ips", [{ id: 8, ip: "198.51.100.5", name: "vip", server: 42, home_location: { name: "fsn1" } }]) },
      { path: "/primary_ips", json: page("primary_ips", []) },
    ]);
    const reruns: Array<[string[], string]> = [
      [["server", "reboot", "web-1", "--wait", "30"], "hetzner-axi server reboot web-1 --wait 30"],
      [["server", "resize", "db-1", "--type", "cx32", "--no-wait"], "hetzner-axi server resize db-1 --type cx32 --no-wait"],
      [["server", "rebuild", "web-1", "--wait=120", "--image", "ubuntu-24.04"], "hetzner-axi server rebuild web-1 --wait=120 --image ubuntu-24.04"],
      [["server", "delete", "42", "--no-wait"], "hetzner-axi server delete 42 --no-wait"],
      [["volume", "detach", "data", "--no-wait"], "hetzner-axi volume detach data --no-wait"],
      [["volume", "resize", "data", "--size", "100", "--wait", "60"], "hetzner-axi volume resize data --size 100 --wait 60"],
      [["ip", "unassign", "198.51.100.5", "--wait", "30"], "hetzner-axi ip unassign 198.51.100.5 --wait 30"],
    ];
    for (const [argv, rerun] of reruns) expect((await run(...argv)).stdout, argv.join(" ")).toContain(`Run \`${rerun} --confirm\` to execute`);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses to delete a protected server before previewing", async () => {
    mockApi([byName("db-1", server("db-1", { protection: { delete: true, rebuild: true } }))]);
    const { stdout, exitCode } = await run("server", "delete", "db-1", "--confirm");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: PROTECTED");
    expect(stdout).toContain("protect db-1 --delete off");
  });

  it("labels are idempotent and merge with existing ones", async () => {
    const { calls } = mockApi([byName("web-1", server("web-1", { labels: { env: "prod" } })), { method: "PUT", path: "/servers/42", json: {} }]);
    expect((await run("server", "label", "web-1", "--set", "env=prod")).stdout).toContain("no-op");
    const { stdout } = await run("server", "label", "web-1", "--set", "team=core", "--remove", "env");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ labels: { team: "core" } });
    expect(stdout).toContain("changed: team=core; -env");
  });
});

describe("server types", () => {
  it("filters by location, sorts by price and hides deprecated", async () => {
    mockApi([{ path: "/server_types", json: page("server_types", [CX32, CX22, { ...CX22, name: "cx11", deprecated: true }]) }]);
    const { stdout } = await run("server", "types", "--location", "fsn1");
    expect(stdout).toContain("server_types[2]{name,cores,memory,eur_month}:");
    expect(stdout).toMatch(/cx22,2,4,4.51\n\s+cx32/);
    expect(stdout).not.toContain("cx11");
  });

  it("adds disk, cpu and arch by --fields", async () => {
    mockApi([{ path: "/server_types", json: page("server_types", [CX22]) }]);
    const { stdout } = await run("server", "types", "--fields", "disk,cpu,arch");
    expect(stdout).toContain("server_types[1]{name,cores,memory,eur_month,disk,cpu,arch}:\n  cx22,2,4,4.51,40,shared,x86\n");
  });
});

describe("list --fields", () => {
  it.each([
    ["server", "list"],
    ["server", "types"],
    ["volume", "list"],
    ["ip", "list"],
    ["lb", "list"],
    ["action", "list"],
    ["image", "list"],
  ])("%s %s rejects an unknown field before any request and its help lists the valid ones", async (command, sub) => {
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run(command, sub, "--fields", "bogus");
    expect(exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    const valid = /available --fields: (.+)/.exec(stdout)![1]!.split(", ");
    expect((await run(command, "--help")).stdout).toContain(`--fields <${valid.join(",")}>`);
  });

  it("volume list shows four fields, device and id on request", async () => {
    const volume = { id: 6, name: "data", size: 50, server: 42, location: { name: "fsn1" }, linux_device: "/dev/disk/by-id/scsi-0HC_Volume_6" };
    mockApi([
      { path: "/volumes", json: page("volumes", [volume]) },
      { path: "/servers", json: page("servers", [server("web-1")]) },
    ]);
    expect((await run("volume", "list")).stdout).toContain("volumes[1]{name,size_gb,server,location}:\n  data,50,web-1,fsn1\n");
    expect((await run("volume", "list", "--fields", "device,id")).stdout).toContain("data,50,web-1,fsn1,/dev/disk/by-id/scsi-0HC_Volume_6,6");
  });

  it("ip list shows four fields, name and id on request", async () => {
    mockApi([
      { path: "/floating_ips", json: page("floating_ips", [{ id: 8, ip: "198.51.100.5", name: "vip", server: 42, home_location: { name: "fsn1" } }]) },
      { path: "/primary_ips", json: page("primary_ips", []) },
      { path: "/servers", json: page("servers", [server("web-1")]) },
    ]);
    expect((await run("ip", "list")).stdout).toContain("ips[1]{ip,kind,server,location}:\n  198.51.100.5,floating,web-1,fsn1\n");
    expect((await run("ip", "list", "--fields", "name,id")).stdout).toContain("198.51.100.5,floating,web-1,fsn1,vip,8");
  });

  it("lb list shows four fields, location and id on request", async () => {
    const lb = { id: 4, name: "web-lb", load_balancer_type: { name: "lb11" }, public_net: { ipv4: { ip: "203.0.113.20" } }, location: { name: "nbg1" }, targets: [] };
    mockApi([{ path: "/load_balancers", json: page("load_balancers", [lb]) }]);
    expect((await run("lb", "list")).stdout).toContain("load_balancers[1]{name,type,ipv4,targets}:\n  web-lb,lb11,203.0.113.20,0 targets\n");
    expect((await run("lb", "list", "--fields", "location,id")).stdout).toContain("web-lb,lb11,203.0.113.20,0 targets,nbg1,4");
  });

  it("action list shows four fields, started on request", async () => {
    const action = { id: 2, command: "start_server", status: "success", started: new Date().toISOString(), resources: [{ id: 42, type: "server" }] };
    mockApi([{ path: "/servers/actions", json: page("actions", [action]) }]);
    expect((await run("action", "list")).stdout).toContain("actions[1]{id,command,status,resource}:\n  2,start_server,success,server 42\n");
    expect((await run("action", "list", "--fields", "started")).stdout).toContain("2,start_server,success,server 42,just now");
  });

  it("snapshot lists show four fields and size_gb on request; system lists take no --fields", async () => {
    const snapshot = { id: 70, type: "snapshot", description: "web-1 nightly", image_size: 1.234, created_from: { id: 42, name: "web-1" }, created: new Date().toISOString() };
    const { calls } = mockApi([{ path: "/images", json: page("images", [snapshot]) }]);
    const listed = (await run("image", "list", "--type", "snapshot")).stdout;
    expect(listed).toContain("images[1]{id,description,from,created}:\n  70,web-1 nightly,web-1,just now\n");
    expect(listed).toMatch(/^count: 1$/m);
    expect((await run("image", "list", "--type", "snapshot", "--fields", "size_gb")).stdout).toContain("70,web-1 nightly,web-1,just now,1.23");
    const system = await run("image", "list", "--fields", "size_gb");
    expect(system.exitCode).toBe(2);
    expect(system.stdout).toContain("only snapshot and backup lists take --fields");
    expect(calls).toHaveLength(2);
  });
});

describe("firewall", () => {
  const fw = { id: 9, name: "web", rules: [{ direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"], destination_ips: [] }], applied_to: [] };

  it("add-rule is a no-op for an existing rule", async () => {
    const { calls } = mockApi([{ path: "/firewalls", json: page("firewalls", [fw]) }]);
    const { stdout } = await run("firewall", "add-rule", "web", "--protocol", "tcp", "--port", "22", "--source-ip", "any", "--confirm");
    expect(stdout).toContain("rule already present (no-op)");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("add-rule previews, then sends the full rule set", async () => {
    const { calls } = mockApi([
      { path: "/firewalls", json: page("firewalls", [fw]) },
      { method: "POST", path: "/firewalls/9/actions/set_rules", json: { actions: [done(5)] } },
    ]);
    expect((await run("firewall", "add-rule", "web", "--protocol", "tcp", "--port", "443", "--source-ip", "any")).stdout).toContain("add in tcp 443 from any");
    await run("firewall", "add-rule", "web", "--protocol", "tcp", "--port", "443", "--source-ip", "any", "--confirm");
    const body = calls.find((c) => c.method === "POST")!.body as { rules: unknown[] };
    expect(body.rules).toHaveLength(2);
    expect(body.rules[1]).toEqual({ direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"] });
  });

  it("previews reruns that keep a --description or --label with spaces intact", async () => {
    mockApi([{ path: "/firewalls", json: page("firewalls", [fw]) }]);
    const rule = await run("firewall", "add-rule", "web", "--protocol", "tcp", "--port", "443", "--source-ip", "any", "--description", "allow web");
    expect(rule.stdout).toContain("Run `hetzner-axi firewall add-rule web --protocol tcp --port 443 --source-ip any --description 'allow web' --confirm` to execute");
    const apply = await run("firewall", "apply", "web", "--label", "env in (prod,staging)");
    expect(apply.stdout).toContain("Run `hetzner-axi firewall apply web --label 'env in (prod,staging)' --confirm` to execute");
  });

  it("validates rule flags before any request", async () => {
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run("firewall", "add-rule", "web", "--protocol", "icmp", "--port", "22", "--source-ip", "any");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--port does not apply to icmp");
    expect(calls).toHaveLength(0);
  });
});

describe("dns", () => {
  const zone = { id: 3, name: "example.com", ttl: 3600, record_count: 4, authoritative_nameservers: { assigned: ["hydrogen.ns.hetzner.com."], delegation_status: "valid" } };
  const zoneRoute = { path: "/zones/example.com", json: { zone } };

  it("creates a missing record set without --confirm", async () => {
    const { calls } = mockApi([zoneRoute, { method: "POST", path: "/zones/3/rrsets", json: { rrset: {}, action: done() } }]);
    const { stdout } = await run("dns", "record", "set", "example.com", "www.example.com", "a", "--record", "203.0.113.10", "--ttl", "300");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "www", type: "A", records: [{ value: "203.0.113.10" }], ttl: 300 });
    expect(stdout).toContain("result: created");
  });

  it("set is a no-op when values match and previews a replacement", async () => {
    const { calls } = mockApi([zoneRoute, { path: "/zones/3/rrsets/www/A", json: { rrset: { name: "www", type: "A", ttl: 300, records: [{ value: "203.0.113.10" }] } } }]);
    expect((await run("dns", "record", "set", "example.com", "www", "A", "--record", "203.0.113.10")).stdout).toContain("no-op");
    const { stdout } = await run("dns", "record", "set", "example.com", "www", "A", "--record", "203.0.113.11");
    expect(stdout).toContain("from: 203.0.113.10");
    expect(stdout).toContain("NOT executed");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("quotes TXT values and compares them unquoted", async () => {
    const { calls } = mockApi([
      { path: "/zones/example.com", json: { zone } },
      { path: "/zones/3/rrsets/@/TXT", json: { rrset: { name: "@", type: "TXT", ttl: null, records: [{ value: '"google-site-verification=abc"' }] } } },
      { method: "POST", path: "/zones/3/rrsets/@/TXT/actions/add_records", json: { action: done() } },
    ]);
    expect((await run("dns", "record", "add", "example.com", "@", "TXT", "--record", "google-site-verification=abc")).stdout).toContain("no-op");
    const { stdout } = await run("dns", "record", "add", "example.com", "example.com", "TXT", "--record", 'v=spf1 include:"x" ~all');
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ records: [{ value: '"v=spf1 include:\\"x\\" ~all"' }] });
    expect(stdout).toContain("result: updated");
  });

  it("set previews pasteable set and add commands for a value with quotes", async () => {
    mockApi([zoneRoute, { path: "/zones/3/rrsets/@/TXT", json: { rrset: { name: "@", type: "TXT", ttl: 300, records: [{ value: '"old"' }] } } }]);
    const { stdout } = await run("dns", "record", "set", "example.com", "@", "TXT", "--record", `it's "new"`);
    expect(stdout).toContain(`Run \`hetzner-axi dns record set example.com @ TXT --record 'it'\\''s "new"' --confirm\` to execute`);
    expect(stdout).toContain(`Run \`hetzner-axi dns record add example.com @ TXT --record 'it'\\''s "new"'\` instead to keep the existing values`);
  });

  it("remove of a missing record set is a no-op", async () => {
    mockApi([zoneRoute]);
    const { stdout } = await run("dns", "record", "remove", "example.com", "old", "CNAME", "--confirm");
    expect(stdout).toContain("no such record set (no-op)");
  });
});

describe("ip and volume", () => {
  it("assigns a floating IP by address", async () => {
    const { calls } = mockApi([
      { path: "/floating_ips", json: page("floating_ips", [{ id: 8, ip: "198.51.100.5", name: "vip", server: null, home_location: { name: "fsn1" } }]) },
      { path: "/primary_ips", json: page("primary_ips", []) },
      byName("web-1", server("web-1")),
      { method: "POST", path: "/floating_ips/8/actions/assign", json: { action: done() } },
    ]);
    await run("ip", "assign", "198.51.100.5", "--server", "web-1", "--confirm");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ server: 42 });
  });

  it("volume create previews a rerun that keeps a --label with spaces intact", async () => {
    mockApi([
      { path: "/volumes", json: page("volumes", []) },
      { path: "/pricing", json: { pricing: { volume: { price_per_gb_month: { gross: "0.0524" } } } } },
    ]);
    const { stdout } = await run("volume", "create", "--name", "data", "--size", "10", "--location", "fsn1", "--label", "team=core infra");
    expect(stdout).toContain("Run `hetzner-axi volume create --name data --size 10 --location fsn1 --label 'team=core infra' --confirm` to execute");
  });

  it("lb view points a miss at lb list", async () => {
    mockApi([{ path: "/load_balancers", json: page("load_balancers", [{ id: 4, name: "web-lb" }]) }]);
    const { stdout, exitCode } = await run("lb", "view", "api-lb");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Run `hetzner-axi lb list`");
    expect(stdout).not.toContain("load-balancer");
  });

  it("volume resize only grows", async () => {
    mockApi([{ path: "/volumes", json: page("volumes", [{ id: 6, name: "data", size: 50, server: null, location: { name: "fsn1" } }]) }]);
    const { stdout, exitCode } = await run("volume", "resize", "data", "--size", "20");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("volumes only grow");
  });
});

describe("ssh-key add", () => {
  const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial test@example";

  it("names an unreadable --public-key-file and the reason before any request", async () => {
    const { calls } = mockApi([]);
    const dir = mkdtempSync(join(tmpdir(), "hetzner-axi-test-"));
    const missing = await run("ssh-key", "add", "--name", "laptop", "--public-key-file", join(dir, "id_ed25519.pub"));
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain(`cannot read --public-key-file '${join(dir, "id_ed25519.pub")}' - no such file or directory`);
    const directory = await run("ssh-key", "add", "--name", "laptop", "--public-key-file", dir);
    expect(directory.exitCode).toBe(2);
    expect(directory.stdout).toContain(`cannot read --public-key-file '${dir}' - it is a directory`);
    expect(calls).toHaveLength(0);
  });

  it("reads a ~/ key file and adds the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "hetzner-axi-test-"));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${KEY}\n`);
    vi.stubEnv("HOME", home);
    const { calls } = mockApi([
      { path: "/ssh_keys", json: page("ssh_keys", []) },
      { method: "POST", path: "/ssh_keys", json: { ssh_key: { id: 5, name: "laptop", fingerprint: "aa:bb" } } },
    ]);
    const { stdout } = await run("ssh-key", "add", "--name", "laptop", "--public-key-file", "~/.ssh/id_ed25519.pub");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "laptop", public_key: KEY });
    expect(stdout).toContain("result: added");
  });
});

describe("action list", () => {
  const action = (id: number, command: string, started: string, type: string, rid: number) => ({ id, command, status: "success", started, resources: [{ id: rid, type }] });

  it("merges collections newest first and counts a 404 collection as empty", async () => {
    const { calls } = mockApi([
      { path: "/servers/actions", json: page("actions", [action(2, "start_server", "2026-01-02T00:00:00Z", "server", 42)]) },
      { path: "/volumes/actions", json: page("actions", [action(3, "attach_volume", "2026-01-03T00:00:00Z", "volume", 6)]) },
    ]);
    const { stdout, exitCode } = await run("action", "list");
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.path === "/zones/actions")).toBe(true);
    expect(stdout.indexOf("attach_volume")).toBeLessThan(stdout.indexOf("start_server"));
  });

  it("reports a rejected token instead of 0 actions", async () => {
    mockApi([
      { path: "/servers/actions", json: page("actions", []) },
      { path: /^\/\w+\/actions$/, status: 401, json: { error: { code: "unauthorized", message: "unable to authenticate" } } },
    ]);
    const { stdout, exitCode } = await run("action", "list");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: AUTH_REQUIRED");
    expect(stdout).not.toContain("0 actions");
  });

  it("reports an unreachable API instead of 0 actions", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { stdout, exitCode } = await run("action", "list", "--running");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: NETWORK");
    expect(stdout).not.toContain("0 running actions");
  });
});

describe("auth with HETZNER_AXI_NO_KEYCHAIN=1", () => {
  it("login is refused before the token is read or sent, and nothing is stored", async () => {
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run("auth", "login", "--context", "prod", "--token-stdin");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("code: VALIDATION_ERROR");
    expect(stdout).toContain("HETZNER_AXI_NO_KEYCHAIN=1 disables the OS keychain so auth login cannot store the token");
    expect(stdout).toContain("Set HCLOUD_TOKEN in the environment instead");
    expect(calls).toHaveLength(0);
    expect(keychain.opened).toHaveLength(0);
    expect(existsSync(join(process.env["HETZNER_AXI_CONFIG_DIR"]!, "config.json"))).toBe(false);
  });

  it("logout is refused and keeps the context", async () => {
    writeConfig({ active: "prod", contexts: ["prod"] });
    const { stdout, exitCode } = await run("auth", "logout", "--context", "prod");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("the token of context 'prod' cannot be removed");
    expect(stdout).toContain("Unset HETZNER_AXI_NO_KEYCHAIN and run `hetzner-axi auth logout --context prod`");
    expect(keychain.opened).toHaveLength(0);
    expect(readConfig()).toEqual({ active: "prod", contexts: ["prod"] });
  });

  it("storeToken and clearToken never open the keychain", async () => {
    await expect(storeToken("prod", "test-token")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(clearToken("prod")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(keychain.opened).toHaveLength(0);
  });

  it("without HCLOUD_TOKEN, commands and auth status point at HCLOUD_TOKEN, not auth login", async () => {
    delete process.env["HCLOUD_TOKEN"];
    writeConfig({ active: "prod", contexts: ["prod"] });
    const { calls } = mockApi([]);
    const list = await run("server", "list");
    expect(list.exitCode).toBe(1);
    expect(list.stdout).toContain("code: AUTH_REQUIRED");
    expect(list.stdout).toContain("Set HCLOUD_TOKEN in the environment");
    expect(list.stdout).not.toContain("auth login");
    const status = await run("auth", "status");
    expect(status.stdout).toContain("HCLOUD_TOKEN is not set and HETZNER_AXI_NO_KEYCHAIN=1 keeps the keychain off");
    expect(status.stdout).not.toContain("auth login");
    expect(calls).toHaveLength(0);
    expect(keychain.opened).toHaveLength(0);
  });
});

describe("help", () => {
  const SUBCOMMANDS: Record<string, string[]> = {
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
  };

  it.each(Object.entries(SUBCOMMANDS))("%s --help has examples and documents every flag its subcommands accept", async (command, subs) => {
    const { calls } = mockApi([]);
    const help = (await run(command, "--help")).stdout;
    expect(help).toMatch(/^examples\[[2-9]\]:$/m);
    for (const sub of subs) {
      // The unknown-flag error lists exactly what the parser accepts.
      const { stdout } = await run(command, ...sub.split(" "), "--bogus");
      const valid = /valid flags for `[^`]+`: (.+) \(--help always allowed\)/.exec(stdout)![1]!;
      if (valid === "(none)") continue;
      const documented = [...help.matchAll(/^flags\{([^}]+)\}:\n(.+)$/gm)].filter((m) => m[1]!.split(",").includes(sub)).map((m) => m[2]).join(" ");
      for (const flag of valid.split(", ")) expect(documented, `${command} ${sub} ${flag}`).toMatch(new RegExp(`(^|[\\s,(|])${flag}(?![\\w-])`));
    }
    expect(calls).toHaveLength(0);
  });

  it("api --help has examples", async () => {
    expect((await run("api", "--help")).stdout).toMatch(/^examples\[[2-9]\]:$/m);
  });
});

describe("errors and api", () => {
  it("explains a Read token on a write", async () => {
    mockApi([byName("web-1", server("web-1")), { method: "POST", path: "/servers/42/actions/poweroff", status: 403, json: { error: { code: "forbidden", message: "insufficient permissions" } } }]);
    const { stdout } = await run("server", "poweroff", "web-1", "--confirm");
    expect(stdout).toContain("code: FORBIDDEN");
    expect(stdout).toContain("Read & Write token");
  });

  it("api refuses absolute URLs and previews DELETE with the full rerun", async () => {
    const { calls } = mockApi([]);
    expect((await run("api", "https://evil.example/x")).exitCode).toBe(2);
    const { stdout } = await run("api", "DELETE", "/servers/42", "--query", "force=true");
    expect(stdout).toContain("NOT executed");
    expect(stdout).toContain("Run `hetzner-axi api DELETE /servers/42 --query force=true --confirm` to execute");
    expect(calls).toHaveLength(0);
  });

  it("api suggests a --full rerun for a truncated read", async () => {
    mockApi([{ path: "/server_types", json: page("server_types", [CX22]) }]);
    const { stdout } = await run("api", "/server_types", "--query", "name=cx22");
    expect(stdout).toContain("run `hetzner-axi api /server_types --query name=cx22 --full` for the raw payload");
  });
});
