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

One line in `CLAUDE.md` / `AGENTS.md`:

```
Use `hetzner-axi` for anything in Hetzner Cloud (servers, firewalls, volumes, IPs, DNS zones).
```

Optional: `hetzner-axi setup hooks` shows the project overview at agent session start.

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
| `HETZNER_AXI_NO_KEYCHAIN` | `1` never reads or writes the OS keychain |
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

Every command has `--help`. Lists show at most four fields per row; `--fields` adds the extras each list's `--help` names.

## Development

```sh
pnpm install
pnpm run check   # typecheck + tests + build + SKILL.md freshness
```

## License

MIT
