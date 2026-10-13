import { DESCRIPTION } from "./cli.js";

// Trigger string agents match against to auto-load the skill.
export const SKILL_DESCRIPTION =
  "Operate Hetzner Cloud through the hetzner-axi CLI - list and inspect servers, create, power, resize, rebuild or delete them, " +
  "manage firewall rules, volumes, floating and primary IPs, SSH keys and DNS zones and records, and compare server types and prices. " +
  "Use whenever a task touches Hetzner, hcloud, a Hetzner server or a DNS zone hosted at Hetzner.";

// Hard cap so a regeneration cannot re-inflate the stub with CLI-owned guidance.
export const MAX_SKILL_MARKDOWN_CHARS = 2000;

/** A discovery stub, not a copy of the CLI's guidance: `hetzner-axi --help` never goes stale. */
export function createSkillMarkdown(): string {
  const markdown = `---
name: hetzner-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# hetzner-axi

${DESCRIPTION}

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- \`npx -y hetzner-axi\` for an overview of the active project
- \`npx -y hetzner-axi --help\` for the command index
- \`npx -y hetzner-axi <command> --help\` for per-command flags and examples

Authentication is a one-time, user-performed step: \`<token-command> | npx -y hetzner-axi auth login --context <project> --token-stdin\`. Never ask for the token in chat or pass it as an argument.
`;
  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(`generated SKILL.md is ${markdown.length} chars; keep it under ${MAX_SKILL_MARKDOWN_CHARS}`);
  }
  return markdown;
}
