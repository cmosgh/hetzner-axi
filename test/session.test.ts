import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookSettings } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandName } from "../src/cli.js";
import { configDir, writeConfig } from "../src/config.js";
import { agentFiles, findHooks, installHooks, ourHook, removeHooks } from "../src/hooks.js";
import { findInvocations, lastSession, recordSession, sessionText, shellSegments, summarizeTranscript } from "../src/sessionlog.js";
import { mockApi, run, useTestEnv } from "./helpers.js";

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

const AGENT_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"];
const saved = {
  home: process.env["HOME"],
  path: process.env["PATH"],
  argv1: process.argv[1],
  cwd: process.cwd(),
  vars: Object.fromEntries(AGENT_VARS.map((v) => [v, process.env[v]])),
};
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
let home = "";

beforeEach(() => {
  useTestEnv();
  keychain.opened.length = 0;
  // Never the real agent or tool config: a fresh HOME, none of the agents' config-dir overrides, useTestEnv's config dir.
  home = realpathSync(mkdtempSync(join(tmpdir(), "hetzner-axi-home-")));
  process.env["HOME"] = home;
  for (const v of AGENT_VARS) delete process.env[v];
  expect(homedir()).toBe(home);
});

afterEach(() => {
  restore("HOME", saved.home);
  restore("PATH", saved.path);
  process.argv[1] = saved.argv1!;
  process.chdir(saved.cwd);
  for (const v of AGENT_VARS) restore(v, saved.vars[v]);
  vi.unstubAllGlobals();
});

const bash = (command: string): string => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

describe("session capture", () => {
  it("splits shell lines on operators and resolves quotes", () => {
    expect(shellSegments(`a 'b c' "d\\"e" && f|g; h\nI=1 j`)).toEqual([["a", "b c", 'd"e'], ["f"], ["g"], ["h"], ["I=1", "j"]]);
  });

  it("records command and subcommand names and the HETZNER_AXI_CONTEXT value, never arguments", () => {
    const find = (line: string) => findInvocations(line, "hetzner-axi", commandName);
    const line = `cd /x && HETZNER_AXI_CONTEXT=staging npx -y hetzner-axi server view web-1 --fields labels | head; hetzner-axi dns record set example.com www A --record 203.0.113.10; hcloud server list`;
    expect(find(line)).toEqual([{ command: "server view", context: "staging" }, { command: "dns record set" }]);
    expect(find("/opt/bin/hetzner-axi web-1 secret")).toEqual([{ command: "other" }]);
    expect(find("hetzner-axi server web-1 --confirm")).toEqual([{ command: "server" }]);
    expect(find("node /usr/lib/node_modules/hetzner-axi/dist/bin/hetzner-axi.js api GET /servers/42 && npx hetzner-axi@latest context")).toEqual([{ command: "api" }, { command: "context" }]);
    expect(find("HETZNER_AXI_CONTEXT='$(cat x)' hetzner-axi auth status")).toEqual([{ command: "auth status" }]);
    expect(find("hetzner-axi --help; hetzner-axi -v; hetzner-axi; hetzner-axi --bogus x")).toEqual([{ command: "help" }, { command: "version" }, { command: "home" }, { command: "other" }]);
    expect(find("echo hetzner-axi; grep hetzner-axi x")).toEqual([]);
  });

  it("summarizes a transcript and keeps the latest session per directory, readable only by the user", async () => {
    const transcript = join(mkdtempSync(join(tmpdir(), "hetzner-axi-transcript-")), "session.jsonl");
    writeFileSync(
      transcript,
      [
        bash("hetzner-axi server list"),
        bash("hetzner-axi server view web-1"),
        bash("HETZNER_AXI_CONTEXT=staging hetzner-axi firewall add-rule web --protocol tcp --port 443 --source-ip 203.0.113.7 --description 'allow web'"),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "hetzner-axi server list" }] } }),
        "not json hetzner-axi",
      ].join("\n"),
    );
    const summary = await summarizeTranscript(transcript, commandName);
    expect(summary).toMatchObject({ commands: { "server list": 1, "server view": 1, "firewall add-rule": 1 }, context: "staging" });
    expect(JSON.stringify(summary)).not.toMatch(/web|203\.0\.113|443|allow/);
    recordSession("/work/a", summary!);
    recordSession("/work/b", { ended: "2026-10-01", commands: { "server list": 2 } });
    expect(lastSession("/work/a")).toEqual(summary);
    expect(sessionText(lastSession("/work/b")!)).toBe("2026-10-01 - server list 2");
    expect(sessionText({ ended: "2026-10-02", commands: { "server view": 1, "server list": 3 }, context: "prod" })).toBe("2026-10-02 - server list 3; server view 1 - context prod");
    expect(lastSession("/work/c")).toBeUndefined();
    expect(statSync(join(configDir(), "sessions.json")).mode & 0o777).toBe(0o600);
    expect(await summarizeTranscript(transcript, () => undefined)).toMatchObject({ commands: { other: 3 } });
  });

  it("keeps only the 100 most recent directories", () => {
    for (let i = 0; i <= 100; i++) recordSession(`/work/${i}`, { ended: "2026-10-01", commands: { "server list": 1 } });
    expect(lastSession("/work/0")).toBeUndefined();
    expect(lastSession("/work/1")).toBeDefined();
    expect(lastSession("/work/100")).toBeDefined();
  });

  it("starts a new log when sessions.json has the wrong shape and skips malformed entries", () => {
    mkdirSync(configDir(), { recursive: true });
    for (const content of ['{"directories": null}', '{"directories": [1]}', "null", "not json"]) {
      writeFileSync(join(configDir(), "sessions.json"), content);
      expect(lastSession("/work/a")).toBeUndefined();
      recordSession("/work/a", { ended: "2026-10-01", commands: { "server list": 1 } });
      expect(lastSession("/work/a")).toMatchObject({ commands: { "server list": 1 } });
    }
    for (const entry of ["5", '{"commands": null}', '{"ended": "2026-10-01"}', "[]", '{"ended": "2026-10-01", "commands": {"query": "x"}}', '{"ended": "2026-10-01", "commands": {}, "context": {}}']) {
      writeFileSync(join(configDir(), "sessions.json"), `{"directories": {"/work/a": ${entry}}}`);
      expect(lastSession("/work/a")).toBeUndefined();
    }
  });
});

describe("hook entries", () => {
  const start = (command: string, extra: object = {}) => ({ matcher: "", hooks: [{ type: "command", command, timeout: 10, ...extra }] });

  it("knows its own hooks by binary name, not by substring", () => {
    expect(ourHook("hetzner-axi context", "hetzner-axi")).toBe("start");
    expect(ourHook("'/Users/a b/bin/hetzner-axi' context end", "hetzner-axi")).toBe("end");
    expect(ourHook("/usr/local/lib/node_modules/hetzner-axi/dist/bin/hetzner-axi.js", "hetzner-axi")).toBe("start");
    expect(ourHook("hetzner-axi", "hetzner-axi")).toBe("start");
    expect(ourHook("mongo-axi context", "hetzner-axi")).toBeUndefined();
    expect(ourHook("/src/hetzner-axi/run.sh", "hetzner-axi")).toBeUndefined();
    expect(ourHook("hetzner-axi server list", "hetzner-axi")).toBeUndefined();
    expect(ourHook("hetzner-axi context && echo hi", "hetzner-axi")).toBeUndefined();
  });

  it("adds start and end hooks, repairs the binary in place and is a no-op when current", () => {
    const settings = { model: "x", hooks: { SessionStart: [start("other-tool")] } } as HookSettings;
    const [first, added] = installHooks(settings, "hetzner-axi", "/old/hetzner-axi", ["start", "end"]);
    expect(added).toBe(true);
    expect(findHooks(first, "hetzner-axi")).toEqual({ start: "/old/hetzner-axi context", end: "/old/hetzner-axi context end" });
    const [moved, repaired] = installHooks(first, "hetzner-axi", "hetzner-axi", ["start", "end"]);
    expect(repaired).toBe(true);
    expect(moved.hooks!.SessionStart).toHaveLength(2);
    expect(findHooks(moved, "hetzner-axi")).toEqual({ start: "hetzner-axi context", end: "hetzner-axi context end" });
    expect(installHooks(moved, "hetzner-axi", "hetzner-axi", ["start", "end"])).toEqual([moved, false]);
    expect(JSON.stringify(moved)).toContain("other-tool");
  });

  it("upgrades what the axi-sdk-js installer wrote, drops duplicates and leaves hand-written hooks", () => {
    const handWritten = { hooks: [{ type: "command", command: "hetzner-axi server list" }] };
    const old = {
      hooks: {
        SessionStart: [start("/usr/local/lib/node_modules/hetzner-axi/dist/bin/hetzner-axi.js"), start("hetzner-axi"), handWritten],
        session_start: [{ type: "command", command: "hetzner-axi" }],
      },
    } as HookSettings;
    const [next] = installHooks(old, "hetzner-axi", "hetzner-axi", ["start"]);
    expect(next.hooks).toEqual({ SessionStart: [start("hetzner-axi context"), handWritten] });
  });

  it("removes only its own hooks and empty containers it emptied", () => {
    const settings = { hooks: { SessionStart: [start("hetzner-axi context"), start("other-tool")], SessionEnd: [start("hetzner-axi context end")] } } as HookSettings;
    const [removed, changed] = removeHooks(settings, "hetzner-axi");
    expect(changed).toBe(true);
    expect(removed).toEqual({ hooks: { SessionStart: [start("other-tool")] } });
    expect(removeHooks({ hooks: { SessionStart: [] } }, "hetzner-axi")[1]).toBe(false);
    expect(removeHooks({ hooks: { SessionStart: [start("hetzner-axi context")] } }, "hetzner-axi")[0]).toEqual({});
  });
});

describe("setup", () => {
  let bin = "";
  const install = (at: string): string => {
    const path = join(home, at, "node_modules", "hetzner-axi", "dist", "bin", "hetzner-axi.js");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    process.argv[1] = path;
    return path;
  };
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as HookSettings;
  const claude = () => readJson(join(home, ".claude", "settings.json"));
  const plugin = () => join(home, ".config", "opencode", "plugins", "axi-hetzner-axi.js");

  beforeEach(() => {
    // The file-level beforeEach moved HOME; every agent file must resolve inside it.
    for (const path of Object.values(agentFiles("hetzner-axi", "user", process.cwd()))) expect(path.startsWith(`${home}/`)).toBe(true);
    bin = install("lib");
  });

  it("installs Claude Code start and end, Codex start with its feature flag and the OpenCode plugin; a rerun is a no-op", async () => {
    const first = await run("setup", "hooks");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("claude_code: installed (session start + end)");
    expect(first.stdout).toContain("codex: installed (session start)");
    expect(first.stdout).toContain("opencode: installed (session start)");
    expect(findHooks(claude(), "hetzner-axi")).toEqual({ start: `${bin} context`, end: `${bin} context end` });
    expect(claude().hooks!["SessionEnd"]).toEqual([{ matcher: "", hooks: [{ type: "command", command: `${bin} context end`, timeout: 30 }] }]);
    expect(findHooks(readJson(join(home, ".codex", "hooks.json")), "hetzner-axi")).toEqual({ start: `${bin} context` });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).toBe("[features]\nhooks = true\n");
    expect(readFileSync(plugin(), "utf-8")).toContain('const args = ["context"];');

    const again = await run("setup", "hooks");
    expect(again.stdout.match(/already up to date \(no-op\)/g)).toHaveLength(3);
    const status = await run("setup", "status");
    expect(status.stdout).toMatch(/claude_code: session start \+ end\n {2}codex: session start\n {2}opencode: session start/);

    const removed = await run("setup", "uninstall");
    expect(removed.stdout.match(/: removed/g)).toHaveLength(3);
    expect(claude()).toEqual({});
    expect(existsSync(plugin())).toBe(false);
    expect((await run("setup", "uninstall")).stdout.match(/not installed \(no-op\)/g)).toHaveLength(3);
  });

  it("uses the bare name when PATH finds this install", async () => {
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    symlinkSync(bin, join(binDir, "hetzner-axi"));
    process.env["PATH"] = `${binDir}${delimiter}${saved.path}`;
    expect((await run("setup", "hooks")).stdout).toContain("runs: hetzner-axi context");
    expect(findHooks(claude(), "hetzner-axi").end).toBe("hetzner-axi context end");
  });

  it("reports a moved binary and repairs the path", async () => {
    await run("setup", "hooks");
    const moved = install("lib2");
    renameSync(join(home, "lib"), join(home, "old-lib"));
    expect((await run("setup", "status")).stdout).toContain("claude_code: broken -");
    expect((await run("setup", "hooks")).stdout).toContain("claude_code: installed (session start + end)");
    expect(findHooks(claude(), "hetzner-axi").start).toBe(`${moved} context`);
    expect((await run("setup", "status")).stdout).toContain("claude_code: session start + end");
  });

  it("reports the overview hook and plugin the axi-sdk-js installer wrote as outdated and upgrades them", async () => {
    mkdirSync(dirname(plugin()), { recursive: true });
    writeFileSync(plugin(), '// axi-sdk-js managed opencode plugin: hetzner-axi\nconst command = "hetzner-axi";\n');
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "hetzner-axi", timeout: 10 }] }] } }));
    const before = (await run("setup", "status")).stdout;
    expect(before).toContain("claude_code: session start - outdated; rerun setup hooks");
    expect(before).toContain("opencode: outdated - rerun setup hooks");
    expect((await run("setup", "hooks")).exitCode).toBe(0);
    expect(claude().hooks!["SessionStart"]).toEqual([{ matcher: "", hooks: [{ type: "command", command: `${bin} context`, timeout: 10 }] }]);
    expect(readFileSync(plugin(), "utf-8")).toContain('const args = ["context"];');
    expect((await run("setup", "status")).stdout).toMatch(/claude_code: session start \+ end\n {2}codex: session start\n {2}opencode: session start/);
  });

  it("fails with SETUP_FAILED on a partial install and keeps what worked", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "hooks.json"), "{not json");
    const { stdout, exitCode } = await run("setup", "hooks");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: SETUP_FAILED");
    expect(stdout).toContain("hooks.json is not valid JSON");
    expect(findHooks(claude(), "hetzner-axi").start).toBe(`${bin} context`);
  });

  it("fails with SETUP_FAILED when an uninstall step fails, after removing the rest", async () => {
    await run("setup", "hooks");
    writeFileSync(join(home, ".codex", "hooks.json"), "{not json");
    const plugin = join(home, ".config", "opencode", "plugins", "axi-hetzner-axi.js");
    const { stdout, exitCode } = await run("setup", "uninstall");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: SETUP_FAILED");
    expect(stdout).toContain("Codex failed - ");
    expect(stdout).toContain("(Claude Code and OpenCode done)");
    expect(stdout).toContain("rerun `hetzner-axi setup uninstall`");
    expect(claude()).toEqual({});
    expect(existsSync(plugin)).toBe(false);
    mkdirSync(plugin);
    expect((await run("setup", "status")).stdout).toMatch(/opencode: "?unreadable - EISDIR/);
    expect((await run("setup", "uninstall")).stdout).toContain("OpenCode failed - ");
  });

  it("reports a Codex config it cannot read", async () => {
    await run("setup", "hooks");
    const config = join(home, ".codex", "config.toml");
    rmSync(config);
    mkdirSync(config);
    const { stdout, exitCode } = await run("setup", "status");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/codex: "?session start - but ~\/\.codex\/config\.toml is unreadable - EISDIR/);
  });

  it("writes project and local scopes under the working directory only", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "hetzner-axi-project-")));
    process.chdir(project);
    expect((await run("setup", "hooks", "--local")).stdout).toContain("claude_code: installed (session start + end)");
    expect(findHooks(readJson(join(project, ".claude", "settings.local.json")), "hetzner-axi").end).toBe(`${bin} context end`);
    expect((await run("setup", "hooks", "--project")).stdout).toContain("teammates need hetzner-axi on PATH");
    expect(existsSync(join(project, ".opencode", "plugins", "axi-hetzner-axi.js"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("honours CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME", async () => {
    for (const [v, dir] of [["CLAUDE_CONFIG_DIR", "claude-dir"], ["CODEX_HOME", "codex-dir"], ["XDG_CONFIG_HOME", "xdg"]] as const) process.env[v] = join(home, dir);
    expect((await run("setup", "hooks")).exitCode).toBe(0);
    expect(findHooks(readJson(join(home, "claude-dir", "settings.json")), "hetzner-axi").start).toBe(`${bin} context`);
    expect(findHooks(readJson(join(home, "codex-dir", "hooks.json")), "hetzner-axi").start).toBe(`${bin} context`);
    expect(existsSync(join(home, "xdg", "opencode", "plugins", "axi-hetzner-axi.js"))).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("refuses an npx copy, whose cache later sessions do not have on PATH", async () => {
    install(join(".npm", "_npx", "3f2a"));
    const { stdout, exitCode } = await run("setup", "hooks");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("runs from the npx cache");
    expect(stdout).toContain("Run `npm install -g hetzner-axi`, then `hetzner-axi setup hooks`");
    expect(stdout).toContain("npx skills add cmosgh/hetzner-axi --skill hetzner-axi");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("refuses a pnpm dlx copy behind a symlink, and the hint keeps the scope", async () => {
    const binDir = join(home, "dlx-bin");
    mkdirSync(binDir);
    symlinkSync(install(join("Library", "Caches", "pnpm", "dlx", "9c1e")), join(binDir, "hetzner-axi"));
    process.argv[1] = join(binDir, "hetzner-axi");
    const project = realpathSync(mkdtempSync(join(tmpdir(), "hetzner-axi-project-")));
    process.chdir(project);
    const { stdout, exitCode } = await run("setup", "hooks", "--local");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("runs from the pnpm dlx cache");
    expect(stdout).toContain("then `hetzner-axi setup hooks --local`");
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("refuses a source checkout", async () => {
    process.argv[1] = join(saved.cwd, "bin", "hetzner-axi.ts");
    const { stdout, exitCode } = await run("setup", "hooks");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("not from a source checkout");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const cliBin = fileURLToPath(new URL("../bin/hetzner-axi.ts", import.meta.url));
const contextEnd = (input: string) => spawnSync(process.execPath, [tsxCli, cliBin, "context", "end"], { input, encoding: "utf-8", env: process.env });

describe("context", () => {
  it("lists the contexts and whether HCLOUD_TOKEN is set, without the API, the keychain or the token's value", async () => {
    const { calls } = mockApi([]);
    process.env["HCLOUD_TOKEN"] = "secret-token-value";
    writeConfig({ active: "prod", contexts: ["prod", "staging"] });
    const { stdout, exitCode } = await run("context");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^bin: /);
    expect(stdout).toContain("contexts: prod (active); staging\nhcloud_token: set - commands use it instead of the stored contexts\n");
    expect(stdout).not.toContain("secret-token-value");
    expect(stdout).not.toContain("last_session");

    // Without HCLOUD_TOKEN or HETZNER_AXI_NO_KEYCHAIN, a keychain read would show up in keychain.opened.
    delete process.env["HCLOUD_TOKEN"];
    delete process.env["HETZNER_AXI_NO_KEYCHAIN"];
    process.env["HETZNER_AXI_CONTEXT"] = "staging";
    const selected = await run("context");
    expect(selected.exitCode).toBe(0);
    expect(selected.stdout).toContain("contexts: prod; staging (HETZNER_AXI_CONTEXT)\nhcloud_token: not set\n");
    expect(selected.stdout).toContain("Switch projects with `hetzner-axi auth use <prod|staging>`");
    expect(calls).toHaveLength(0);
    expect(keychain.opened).toHaveLength(0);
  });

  it("says not configured with the login hint", async () => {
    delete process.env["HCLOUD_TOKEN"];
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run("context");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hetzner: not configured");
    expect(stdout).toContain("auth login --context <project-name> --token-stdin");
    expect(calls).toHaveLength(0);
  });

  it("shows what the last session in this directory ran, as recorded by context end", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "hetzner-axi-project-")));
    const transcript = join(project, "t.jsonl");
    writeFileSync(transcript, bash("HETZNER_AXI_CONTEXT=staging hetzner-axi server view web-1"));
    const end = contextEnd(JSON.stringify({ hook_event_name: "SessionEnd", transcript_path: transcript, cwd: project }));
    expect(end.status).toBe(0);
    expect(end.stdout).toMatch(/^recorded: \d{4}-\d\d-\d\d - server view 1 - context staging$/m);
    process.chdir(project);
    expect((await run("context")).stdout).toMatch(/^last_session: \d{4}-\d\d-\d\d - server view 1 - context staging$/m);
  }, 30_000);

  it("context end records nothing, with exit 0, for a payload it cannot use", () => {
    const empty = join(mkdtempSync(join(tmpdir(), "hetzner-axi-transcript-")), "t.jsonl");
    writeFileSync(empty, bash("hcloud server list"));
    for (const input of ["", "{}", "null", JSON.stringify({ transcript_path: "/nonexistent/t.jsonl" }), JSON.stringify({ transcript_path: empty })]) {
      const r = contextEnd(input);
      expect(r.status, input).toBe(0);
      expect(r.stdout, input).toMatch(/^recorded: nothing - /);
    }
  }, 30_000);

  it("context end on a terminal is a usage error", async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const { stdout, exitCode } = await run("context", "end");
      expect(exitCode).toBe(2);
      expect(stdout).toContain("context end reads a session-end hook payload on stdin");
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});
