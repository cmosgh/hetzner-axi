# hetzner-axi

Agent-ergonomic **Hetzner Cloud** CLI, built on the [AXI](https://axi.md) principles: token-efficient [TOON](https://toonformat.dev/) output, minimal schemas, definitive empty states, structured errors, idempotent mutations, and next-step hints.

It talks to the Hetzner Cloud API directly - no `hcloud` binary needed. Everything that costs money, cuts traffic or destroys data **previews until `--confirm`**, and every mutation waits for Hetzner's asynchronous action to finish.

```
$ hetzner-axi
context: prod
server_count: 3 (2 running; 1 off)
servers[3]{name,status,type,ipv4}:
  build-1,off,cx32,203.0.113.12
  db-1,running,ccx13,203.0.113.11
  web-1,running,cx22,203.0.113.10
help[2]:
  Run `hetzner-axi server view <name>` for details
  Run `hetzner-axi --help` for every command
```

> **Status: early (v0.1.x).** Covered by unit and mocked end-to-end tests.

## Install

Requires Node.js 20+.

```sh
npm install -g hetzner-axi
```

Then tell your agent about it with the session hook or the skill (you only need one): see [Agent integration](#agent-integration).

## Authenticate

Hetzner Cloud tokens belong to **one project**. Create one in the [Cloud Console](https://console.hetzner.cloud/) under *Security - API tokens*:

| Permission | For |
| --- | --- |
| **Read** | everything that reads (list, view, types, prices, DNS records) |
| **Read & Write** | create, power, resize, rebuild, delete, firewall rules, volumes, IPs, DNS changes |

```sh
pbpaste | hetzner-axi auth login --context prod --token-stdin
hetzner-axi auth status    # shows whether the token is Read or Read & Write
hetzner-axi auth use staging
```

- The token is read **only from stdin** - never from argv, so it cannot land in shell history or an agent transcript - validated, then stored in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret). `hetzner-axi` never prompts.
- Store one **context** per project and switch with `auth use`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `HCLOUD_TOKEN` | Token to use; overrides stored contexts (same variable as the `hcloud` CLI) |
| `HETZNER_AXI_CONTEXT` | Stored context for one command, without switching the active one |
| `HETZNER_AXI_NO_KEYCHAIN` | `1` never reads or writes the OS keychain: pair it with `HCLOUD_TOKEN`; `auth login` and `auth logout` are refused |
| `HETZNER_AXI_CONFIG_DIR` | Config directory (default `$XDG_CONFIG_HOME/hetzner-axi` or `~/.config/hetzner-axi`) |

## Commands

| Command | What it does |
| --- | --- |
| `hetzner-axi` | Active project: server count by status, not-running servers first |
| `server list` / `view <server>` | `--status`, `--label env=prod`, `--fields location,eur_month,labels,...`; view shows spec, price, IPs, firewalls, volumes, protection |
| `server types` | Specs and gross EUR/month, `--location fsn1`, `--arch arm`, `--cpu dedicated`, `--fields disk,cpu,arch` |
| `server create` | `--name --type --image --location --ssh-key --firewall --network --label --user-data-file`; previews the price; no-op if the name exists |
| `server poweron` / `shutdown` / `reboot` / `poweroff` / `reset` | Status-aware no-ops; disruptive ones preview |
| `server resize` / `rebuild` / `delete` | Checks status and protection before previewing |
| `server label` / `protect` / `snapshot` | Idempotent labels and protection; snapshots wait for completion |
| `firewall list` / `view` / `create` / `add-rule` / `remove-rule` / `apply` / `remove-from` / `delete` | Rules by flags (`--protocol tcp --port 443 --source-ip any`), set atomically |
| `volume list` / `create` / `attach` / `detach` / `resize` / `delete` | Price preview; grow-only resize |
| `ip list` / `assign` / `unassign` | Floating and primary IPs by address |
| `dns zone list` / `view` / `create` / `delete` | Hetzner Cloud DNS zones, delegation status |
| `dns record list` / `set` / `add` / `remove` | Record sets by name and type; TXT quoting handled; `set` previews replacements |
| `ssh-key list` / `add` / `delete` | `add` is a no-op for a key already stored |
| `image list` / `delete`, `location list`, `network list`, `lb list` / `view`, `action list` / `view` | Catalog and read-only views |
| `api [METHOD] /path` | Escape hatch; `DELETE` needs `--confirm` |
| `setup hooks` / `status` / `uninstall`, `context` | Agent session hooks, see [Agent integration](#agent-integration) |

Every command has `--help`. Lists show at most four fields per row; `--fields` adds the extras each list's `--help` names.

## Agent integration

There are two ways to tell an agent about `hetzner-axi`. You only need one.

| | Session hook | Skill |
|---|---|---|
| Install | `hetzner-axi setup hooks` | `npx skills add cmosgh/hetzner-axi --skill hetzner-axi` |
| What the agent gets | a summary at every session start (about 200 tokens): the stored contexts, whether `HCLOUD_TOKEN` is set, what the last session in this directory ran, and the commands to try | a short skill that loads when a task touches Hetzner Cloud and points at `hetzner-axi --help` |
| Cost | every session | only when the task needs it |
| Agents | Claude Code, Codex, OpenCode | any agent that reads [Agent Skills](https://agentskills.io) |

### Session hook

`hetzner-axi setup hooks` installs two hooks:

- **Session start** (Claude Code, Codex, OpenCode) runs `hetzner-axi context`, which prints the summary below. It reads only the config file and the session log. It never calls the Hetzner API or reads the keychain, so it adds no delay, and it always exits 0. For live server state the agent runs `hetzner-axi`.
- **Session end** (Claude Code) runs `hetzner-axi context end`. It reads the session transcript and records which `hetzner-axi` commands ran: command names, counts and the `HETZNER_AXI_CONTEXT` value, never server names, IPs, labels or other arguments. The record goes in `~/.config/hetzner-axi/sessions.json` (the config directory), keyed by directory, and the next session in that directory sees it as `last_session`.

```text
$ hetzner-axi context
bin: ~/.npm-global/bin/hetzner-axi
description: "Hetzner Cloud CLI for agents - servers (create, power, resize, rebuild, delete), firewalls, volumes, floating and primary IPs, networks, load balancers and DNS zones. Changes preview until --confirm. Prefer it over raw API calls."
contexts: prod (active); staging
hcloud_token: not set
last_session: 2026-10-23 - server list 3; server view 2; firewall add-rule 1 - context staging
help[3]:
  Run `hetzner-axi` for live server state; `hetzner-axi --help` for commands
  Run `hetzner-axi server list`, `hetzner-axi firewall list` or `hetzner-axi dns zone list` to explore; `hetzner-axi <command> --help` for flags
  Switch projects with `hetzner-axi auth use <prod|staging>`, or prefix one command with `HETZNER_AXI_CONTEXT=<name>`
```

| Command | Applies to | Files written |
|---|---|---|
| `hetzner-axi setup hooks` | every session of yours | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.config/opencode/plugins/`; Codex also needs `[features] hooks = true` in `~/.codex/config.toml`, which this adds |
| `hetzner-axi setup hooks --project` | everyone working in this repository (commit the files) | `.claude/settings.json`, `.codex/hooks.json`, `.opencode/plugins/`, and the same Codex flag in `~/.codex/config.toml` |
| `hetzner-axi setup hooks --local` | only you, only in this repository (Claude Code) | `.claude/settings.local.json`; it says so if git would commit the file |

- **Scope:** run `--project` and `--local` from the repository root. `setup status` and `setup uninstall` take the same flag. User-scope paths follow `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` when they are set.
- **Repairs:** rerun `setup hooks` after you upgrade or move the install. It rewrites the hook command and is a no-op when nothing changed. `setup status` shows `broken` or `outdated` when a rerun is needed. Hooks installed by 0.1.0 ran the live overview at session start, and a rerun switches them to `context`.
- **Other hooks:** setup changes only its own hooks. It recognises them by the binary name and `context` argument, and leaves any other hook alone.

### Skill

`npx skills add cmosgh/hetzner-axi --skill hetzner-axi` installs [`skills/hetzner-axi/SKILL.md`](skills/hetzner-axi/SKILL.md). It carries no live state and no per-session cost: the agent loads it when a task touches Hetzner Cloud, and it points at `npx -y hetzner-axi --help` for current guidance. The file is generated from the CLI's own description, and CI fails when it is stale.

## Development

```sh
pnpm install
pnpm run check   # typecheck + tests + build + SKILL.md freshness
```

## License

MIT
