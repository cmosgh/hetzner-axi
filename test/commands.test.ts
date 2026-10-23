import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CX22, CX32, done, mockApi, page, run, running, server, useTestEnv } from "./helpers.js";

beforeEach(() => useTestEnv());
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
    expect(stdout.indexOf("db-1")).toBeLessThan(stdout.indexOf("web-1"));
  });
});

describe("server list and view", () => {
  it("lists five default fields and extras by --fields", async () => {
    const { calls } = mockApi([{ path: "/servers", json: page("servers", [server("web-1", { labels: { env: "prod" } })]) }]);
    const { stdout } = await run("server", "list", "--label", "env=prod", "--fields", "eur_month,labels");
    expect(calls[0]!.url.searchParams.get("label_selector")).toBe("env=prod");
    expect(stdout).toContain("servers[1]{name,status,type,ipv4,location,eur_month,labels}:");
    expect(stdout).toContain("web-1,running,cx22,203.0.113.10,fsn1,4.51,env=prod");
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
    expect(stdout).toMatch(/cx22,2,4,40,shared,x86,4.51\n\s+cx32/);
    expect(stdout).not.toContain("cx11");
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

describe("errors and api", () => {
  it("explains a Read token on a write", async () => {
    mockApi([byName("web-1", server("web-1")), { method: "POST", path: "/servers/42/actions/poweroff", status: 403, json: { error: { code: "forbidden", message: "insufficient permissions" } } }]);
    const { stdout } = await run("server", "poweroff", "web-1", "--confirm");
    expect(stdout).toContain("code: FORBIDDEN");
    expect(stdout).toContain("Read & Write token");
  });

  it("api refuses absolute URLs and previews DELETE", async () => {
    const { calls } = mockApi([]);
    expect((await run("api", "https://evil.example/x")).exitCode).toBe(2);
    expect((await run("api", "DELETE", "/servers/42")).stdout).toContain("NOT executed");
    expect(calls).toHaveLength(0);
  });
});
