/** .ru availability check: DNS NS via 1.1.1.1, then whois.ru for the rest. */

export type Whois = { kind: "free" } | { kind: "taken"; state: string } | { kind: "captcha" } | { kind: "unknown" };

/** Split on space/comma/newline, lowercase, keep [a-z0-9-]+, dedupe (first-seen order). */
export function parseNames(input: string): string[] {
  const all = input.toLowerCase().split(/[\s,]+/).filter((n) => /^[a-z0-9-]+$/.test(n));
  return [...new Set(all)];
}

/** Parse a whois.ru page: tags stripped, then free / first `state:` / captcha, in that order. */
export function parseWhois(html: string): Whois {
  const lines = html.replace(/<[^>]*>/g, "\n").split("\n");
  const text = lines.join("\n");
  if (text.includes("свободен")) return { kind: "free" };
  const state = lines.find((l) => l.includes("state:"));
  if (state) return { kind: "taken", state: state.split(":")[1].trim() };
  if (text.includes("защиту от роботов")) return { kind: "captcha" };
  return { kind: "unknown" };
}

/** Plain code-unit order, like `LC_ALL=C sort`. */
export const sortLines = (lines: string[]) => [...lines].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const DNS_TIMEOUT_MS = 3000;
const DNS_ATTEMPTS = 2;

type Resolver = (domain: string, signal: AbortSignal) => Promise<unknown>;

const resolveNs: Resolver = (domain, signal) =>
  Deno.resolveDns(domain, "NS", { nameServer: { ipAddr: "1.1.1.1" }, signal });

/**
 * Deno.resolveDns throws NotFound for both NXDOMAIN and NODATA (verified against 1.1.1.1), so only a
 * successful NS answer counts as delegated; everything else goes on to whois, which is authoritative.
 */
export async function delegated(name: string, resolve: Resolver = resolveNs): Promise<boolean> {
  for (let attempt = 0; attempt < DNS_ATTEMPTS; attempt++) {
    try {
      await resolve(`${name}.ru`, AbortSignal.timeout(DNS_TIMEOUT_MS));
      return true;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return false; // definitive answer, retrying won't help
    }
  }
  return false; // timed out every time: treat as not delegated, whois decides
}

async function whois(name: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://whois.ru/${name}.ru`, { signal: AbortSignal.timeout(20_000) });
      const w = parseWhois(await res.text());
      if (w.kind === "free") return `FREE ${name}`;
      if (w.kind === "taken") return `taken-whois ${name} (${w.state})`;
      if (w.kind === "captcha") {
        console.error("captcha: whois.ru blocked, stop and retry later");
        return `ERR ${name}`;
      }
    } catch { /* timeout or network error: retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return `ERR ${name}`;
}

/** Check names; returns sorted result lines. */
export async function check(names: string[], whoisParallel: number): Promise<string[]> {
  const dns = await pool(names, 40, async (n) => [n, await delegated(n)] as const);
  const rest = dns.filter(([, d]) => !d).map(([n]) => n);
  const taken = dns.filter(([, d]) => d).map(([n]) => `taken-delegated ${n}`);
  return sortLines([...taken, ...await pool(rest, whoisParallel, whois)]);
}
