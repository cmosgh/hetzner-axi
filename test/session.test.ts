import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandName } from "../src/cli.js";
import { configDir, writeConfig } from "../src/config.js";
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
