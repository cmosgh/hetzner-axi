# hetzner-axi - contributor notes for agents

AXI-compliant Hetzner Cloud CLI. Read the AXI principles (https://axi.md) before changing output.

- **Output is the product.** Every stdout byte costs tokens. Default list schemas stay at 3-4 fields; extras go behind `--fields` (a `Fields` map per list, see `extraFields()` in `src/render.ts`). Keep numbers as numbers (TOON quotes numeric-looking strings). Avoid commas, colons and double quotes inside literal TOON string values.
- **Handlers return strings** built with `block()` (TOON), `helpBlock()` (one suggestion per line) and `out()` from `src/render.ts`.
- **Every flag is declared.** `parseArgs()` in `src/args.ts` rejects unknown flags with the valid set inline. Validate all input before the first network call; usage errors are `VALIDATION_ERROR` (exit 2).
- **Mutations are idempotent** (pre-check state, report `(no-op)`, exit 0). Anything that costs money, cuts traffic or destroys data previews until `--confirm` (`preview()` in `src/resources.ts`). Mutations wait for the Hetzner action (`settle()`), `--no-wait` returns early.
- **Resources are addressed by name or id** through `findOne()`; misses list close names.
- **`context` runs at every session start** (the hook from `setup hooks`): it reads only the config file and the session log - never the network or the keychain - and exits 0. `context end`, Claude Code's session-end hook, records command names, counts and the `HETZNER_AXI_CONTEXT` value, never other arguments, and exits 0 for any payload. The no-argument home view is live; until hetzner-axi is configured it too stays off the network and the keychain.
- **Hooks are ours by binary name** (`ourHook()` in `src/hooks.ts`): the first word is `hetzner-axi` or `hetzner-axi.js`, running `context`, `context end` or nothing (the SDK's old overview hook, upgraded in place). Never run `setup`, `auth login` or `context end` against the real `HOME`: tests use a temporary `HOME` with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` unset.
- **Secrets**: tokens come from stdin or `HCLOUD_TOKEN` only, live in the OS keychain per context, and are sent only to the API base (`buildUrl()` in `src/client.ts`).
- `src/version.ts` is a leaf module (node builtins only) for the `--version` fast path.
- Tests: `test/unit.test.ts` (pure logic), `test/commands.test.ts` (whole CLI via `main()` with a mocked `fetch`) and `test/session.test.ts` (context, session capture, hooks and setup). Fixtures are synthetic - documentation IP ranges, no real project or server names.
- `pnpm run check` must pass. `skills/hetzner-axi/SKILL.md` is generated: `pnpm run build:skill`.
