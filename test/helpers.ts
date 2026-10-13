import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { main } from "../src/cli.js";

export interface Route {
  method?: string;
  /** Path below /v1, matched exactly unless a RegExp is given. */
  path: string | RegExp;
  status?: number;
  json?: unknown;
  /** Dynamic response; wins over json. */
  reply?: (call: Call) => { status?: number; json?: unknown };
}

export interface Call {
  method: string;
  url: URL;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Env-based credentials so tests never touch the real OS keychain. */
export function useTestEnv(): void {
  process.env["HCLOUD_TOKEN"] = "test-token";
  process.env["HETZNER_AXI_NO_KEYCHAIN"] = "1";
  process.env["HETZNER_AXI_POLL_MS"] = "1";
  process.env["HETZNER_AXI_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "hetzner-axi-test-"));
  delete process.env["HETZNER_AXI_CONTEXT"];
  delete process.env["HETZNER_AXI_API_BASE"];
}

export function mockApi(routes: Route[]): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const call: Call = {
      method,
      url,
      path,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes.find((r) => (r.method ?? "GET") === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)));
    if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: `no mock for ${method} ${path}` } }), { status: 404 });
    const dynamic = route.reply?.(call);
    const status = dynamic?.status ?? route.status ?? 200;
    const json = dynamic?.json ?? route.json;
    return new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status });
  });
  return { calls };
}

export async function run(...argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  process.exitCode = 0;
  await main({ argv, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, exitCode };
}

export const page = (key: string, items: unknown[]): Record<string, unknown> => ({
  [key]: items,
  meta: { pagination: { page: 1, per_page: 50, previous_page: null, next_page: null, last_page: 1, total_entries: items.length } },
});

export const done = (id = 1, command = "x"): Record<string, unknown> => ({ id, command, status: "success", progress: 100, error: null });
export const running = (id = 1, command = "x"): Record<string, unknown> => ({ id, command, status: "running", progress: 0, error: null });

const PRICES = [
  { location: "fsn1", price_hourly: { net: "0.006", gross: "0.0071" }, price_monthly: { net: "3.79", gross: "4.51" } },
  { location: "hel1", price_hourly: { net: "0.006", gross: "0.0071" }, price_monthly: { net: "3.79", gross: "4.51" } },
];

export const CX22 = { id: 1, name: "cx22", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false, prices: PRICES, locations: [{ name: "fsn1", available: true }, { name: "hel1", available: true }] };
export const CX32 = { ...CX22, id: 2, name: "cx32", cores: 4, memory: 8, disk: 80, prices: PRICES.map((p) => ({ ...p, price_monthly: { net: "6.30", gross: "7.50" } })) };

export function server(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name,
    status: "running",
    created: new Date(Date.now() - 86_400_000).toISOString(),
    public_net: { ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8::/64" }, floating_ips: [], firewalls: [] },
    private_net: [],
    server_type: CX22,
    location: { name: "fsn1", city: "Falkenstein", country: "DE" },
    image: { id: 7, name: "ubuntu-24.04", description: "Ubuntu 24.04", architecture: "x86" },
    protection: { delete: false, rebuild: false },
    labels: {},
    volumes: [],
    primary_disk_size: 40,
    ...extra,
  };
}
