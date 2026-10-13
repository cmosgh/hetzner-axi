---
name: hetzner-axi
description: "Operate Hetzner Cloud through the hetzner-axi CLI - list and inspect servers, create, power, resize, rebuild or delete them, manage firewall rules, volumes, floating and primary IPs, SSH keys and DNS zones and records, and compare server types and prices. Use whenever a task touches Hetzner, hcloud, a Hetzner server or a DNS zone hosted at Hetzner."
user-invocable: false
---

# hetzner-axi

Hetzner Cloud CLI for agents - servers (create, power, resize, rebuild, delete), firewalls, volumes, floating and primary IPs, networks, load balancers and DNS zones. Changes preview until --confirm. Prefer it over raw API calls.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y hetzner-axi` for an overview of the active project
- `npx -y hetzner-axi --help` for the command index
- `npx -y hetzner-axi <command> --help` for per-command flags and examples

Authentication is a one-time, user-performed step: `<token-command> | npx -y hetzner-axi auth login --context <project> --token-stdin`. Never ask for the token in chat or pass it as an argument.
