import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { buildUrl } from "../src/client.js";
import { keyMaterial } from "../src/commands/catalog.js";
import { formatTxt, parseTxt, recordName } from "../src/commands/dns.js";
import { normalizeRule, ruleFromFlags, sameRule } from "../src/commands/firewall.js";
import { rerunCommand, shellQuote } from "../src/render.js";
import { formatLabels, monthlyPrice, parseLabels } from "../src/resources.js";
import { createSkillMarkdown } from "../src/skill.js";
import { CX22 } from "./helpers.js";

describe("dns values", () => {
  it("quotes, escapes and chunks TXT like hcloud-go", () => {
    expect(formatTxt("hello world")).toBe('"hello world"');
    expect(formatTxt('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatTxt('"already"')).toBe('"already"');
    const long = formatTxt("a".repeat(300));
    expect(long).toBe(`"${"a".repeat(255)}" "${"a".repeat(45)}"`);
    expect(parseTxt(long)).toBe("a".repeat(300));
  });

  it("normalizes record names relative to the zone", () => {
    expect(recordName("example.com", "example.com")).toBe("@");
    expect(recordName("WWW.example.com.", "example.com")).toBe("www");
    expect(recordName("@", "example.com")).toBe("@");
    expect(recordName("mail", "example.com")).toBe("mail");
  });
});

describe("firewall rules", () => {
  it("expands 'any', adds host prefixes and compares order-insensitively", () => {
    const rule = ruleFromFlags(parseArgs(["--protocol", "tcp", "--port", "22", "--source-ip", "any", "--source-ip", "198.51.100.7"], [{ name: "--protocol" }, { name: "--port" }, { name: "--source-ip", repeatable: true }, { name: "--direction" }, { name: "--destination-ip", repeatable: true }], "t"), "u");
    expect(rule.source_ips).toEqual(["0.0.0.0/0", "198.51.100.7/32", "::/0"]);
    expect(sameRule(rule, normalizeRule({ direction: "in", protocol: "tcp", port: "22", source_ips: ["::/0", "198.51.100.7/32", "0.0.0.0/0"] }))).toBe(true);
  });
});

describe("hint commands", () => {
  it("quotes only what a shell would split or expand, and the shell reads it back unchanged", () => {
    expect(shellQuote("web-1")).toBe("web-1");
    expect(shellQuote("env=prod,team=core")).toBe("env=prod,team=core");
    expect(shellQuote("allow web")).toBe("'allow web'");
    for (const value of ["allow web", "it's", '"quoted"', "$HOME", "a;b|c", "*", "~/x", ""]) {
      expect(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf-8" })).toBe(value);
    }
  });

  it("rebuilds an invocation without --confirm, replacing or adding flags", () => {
    expect(rerunCommand("t create", ["--name", "a b", "--confirm"])).toBe("t create --name 'a b'");
    expect(rerunCommand("t list", ["--status", "off", "--limit", "5"], { "--limit": "50" })).toBe("t list --status off --limit 50");
    expect(rerunCommand("t list", ["--limit=5"], { "--limit": "50", "--full": true })).toBe("t list --limit 50 --full");
    expect(rerunCommand("t add", ["x", "--", "--confirm"], { "--n": "1" })).toBe("t add x --n 1 -- --confirm");
  });
});

describe("helpers", () => {
  it("parses and formats labels", () => {
    expect(parseLabels(["env=prod,team=core", "managed"])).toEqual({ env: "prod", team: "core", managed: "" });
    expect(formatLabels({ env: "prod", managed: "" })).toBe("env=prod; managed");
    expect(() => parseLabels(["bad key=x"])).toThrow(/invalid label key/);
  });

  it("picks gross monthly prices per location", () => {
    expect(monthlyPrice(CX22.prices, "fsn1")).toBe(4.51);
    expect(monthlyPrice(CX22.prices, "nbg1")).toBeUndefined();
  });

  it("compares ssh keys without their comment", () => {
    expect(keyMaterial("ssh-ed25519 AAAA laptop")).toBe(keyMaterial("ssh-ed25519 AAAA other\n"));
  });

  it("never sends the token outside the API base", () => {
    expect(() => buildUrl("https://api.hetzner.cloud/v1", "https://evil.example/v1/servers")).toThrow(/refusing/);
    expect(buildUrl("https://api.hetzner.cloud/v1", "/servers", { label_selector: "env=prod" }).toString()).toBe("https://api.hetzner.cloud/v1/servers?label_selector=env%3Dprod");
  });

  it("keeps the skill a short discovery stub", () => {
    expect(createSkillMarkdown()).toContain("name: hetzner-axi");
  });
});
