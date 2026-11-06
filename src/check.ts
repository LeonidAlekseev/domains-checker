import { parseServer, parseWhois43, type Query, whoisQuery } from "./whois43.ts";

/** Domain availability check: DNS NS via 1.1.1.1, then whois.ru (.ru .su .рф), RDAP (IANA bootstrap) or port 43 whois. */

export type Whois = { kind: "free" } | { kind: "taken"; state: string } | { kind: "captcha" } | { kind: "unknown" };

/** Split on space/comma/newline, lowercase, keep dotted or dotless labels of letters/digits/`-` (IDN ok), dedupe. */
export function parseNames(input: string): string[] {
  const all = input.toLowerCase().split(/[\s,]+/).filter((n) => /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*$/u.test(n));
  return [...new Set(all)];
}

/** Punycode form of a domain, used for every request; "" if it is not a valid host. */
export function asciiDomain(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return "";
  }
}

export const zoneOf = (domain: string) => asciiDomain(domain).split(".").pop()!;

/** A name without a dot is checked in every zone, a name with a dot as is; invalid hosts are dropped. */
export function toDomains(names: string[], zones: string[]): string[] {
  const all = names.flatMap((n) => n.includes(".") ? [n] : zones.map((z) => `${n}.${z}`));
  return [...new Set(all)].filter((d) => asciiDomain(d));
}

/** IANA RDAP bootstrap (dns.json) to a tld -> base URL map (trailing slash ensured). */
export function parseBootstrap(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const [tlds, urls] of (json as { services: [string[], string[]][] }).services) {
    const base = urls[0].endsWith("/") ? urls[0] : urls[0] + "/";
    for (const t of tlds) map.set(t, base);
  }
  return map;
}

/** Retry-After header (seconds or HTTP date) in ms; undefined if absent or unparsable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const secs = Number(header);
  if (header.trim() !== "" && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return isNaN(at) ? undefined : Math.max(0, at - now);
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

export type Resolver = (domain: string, signal: AbortSignal) => Promise<unknown>;

const resolveNs: Resolver = (domain, signal) =>
  Deno.resolveDns(domain, "NS", { nameServer: { ipAddr: "1.1.1.1" }, signal });

/**
 * Deno.resolveDns throws NotFound for both NXDOMAIN and NODATA (verified against 1.1.1.1), so only a
 * successful NS answer counts as delegated; everything else goes on to whois, which is authoritative.
 */
export async function delegated(domain: string, resolve: Resolver = resolveNs): Promise<boolean> {
  for (let attempt = 0; attempt < DNS_ATTEMPTS; attempt++) {
    try {
      await resolve(domain, AbortSignal.timeout(DNS_TIMEOUT_MS));
      return true;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return false; // definitive answer, retrying won't help
    }
  }
  return false; // timed out every time: treat as not delegated, whois decides
}

export type CaptchaChoice = "continue" | "stop" | "no-terminal";

export type WhoisOpts = {
  /** Returns the fetch to use, optionally through a proxy URL. */
  fetcher?: (proxy?: string) => typeof fetch;
  /** Proxies to rotate through, one per captcha, before asking the user. */
  proxies?: string[];
  /** Ask the user to pass the captcha at `link`. */
  prompt?: (link: string) => Promise<CaptchaChoice>;
  resolve?: Resolver;
  /** Port 43 whois query, replaceable in tests. */
  query?: Query;
  /** Wait between retries (also the default when a 429 has no Retry-After). */
  retryMs?: number;
};

const defaultFetcher = (proxy?: string): typeof fetch => {
  if (!proxy) return fetch;
  const client = Deno.createHttpClient({ proxy: { url: proxy } }); // one client per proxy, so connections are reused
  return (url, init) => fetch(url, { ...init, client });
};

/**
 * whois.ru stage. On the first captcha no new request starts (requests already in flight may finish)
 * until a proxy is swapped in or the user continues; on stop the unchecked names become ERR.
 */
export async function whoisStage(domains: string[], parallel: number, o: WhoisOpts = {}): Promise<string[]> {
  const fetcher = o.fetcher ?? defaultFetcher;
  const proxies = [...o.proxies ?? []];
  const prompt = o.prompt ?? (() => Promise.resolve<CaptchaChoice>("no-terminal"));
  let doFetch = fetcher();
  let epoch = 0; // bumped after each resolved captcha; a captcha from an older epoch is already handled
  let stopped = false;
  let resolving: Promise<void> | undefined;

  const resolveCaptcha = (domain: string, seen: number) => {
    if (stopped || seen !== epoch) return resolving;
    resolving ??= (async () => {
      const proxy = proxies.shift();
      if (proxy) {
        console.error(`captcha: whois.ru blocked, switching to proxy ${proxy}`);
        doFetch = fetcher(proxy);
      } else {
        const choice = await prompt(`https://whois.ru/${asciiDomain(domain)}`);
        if (choice !== "continue") {
          stopped = true;
          console.error(
            choice === "stop"
              ? "captcha: whois.ru blocked, stopped by user; unchecked names are ERR"
              : "captcha: whois.ru blocked and no terminal to ask, stop and retry later",
          );
        }
      }
      epoch++;
    })().finally(() => resolving = undefined);
    return resolving;
  };

  const one = async (domain: string): Promise<string> => {
    for (let attempt = 0; attempt < 3;) {
      await resolving;
      if (stopped) break;
      const seen = epoch;
      try {
        const res = await doFetch(`https://whois.ru/${asciiDomain(domain)}`, { signal: AbortSignal.timeout(20_000) });
        const w = parseWhois(await res.text());
        if (w.kind === "free") return `FREE ${domain}`;
        if (w.kind === "taken") return `taken-whois ${domain} (${w.state})`;
        if (w.kind === "captcha") {
          await resolveCaptcha(domain, seen);
          continue; // a captcha is not a failed attempt
        }
      } catch { /* timeout or network error: retry */ }
      attempt++;
      await new Promise((r) => setTimeout(r, o.retryMs ?? 2000));
    }
    return `ERR ${domain}`;
  };
  return await pool(domains, parallel, one);
}

/** Zones whois.ru answers (.рф is a redirect to its Unicode URL, which fetch follows). */
const WHOIS_RU = new Set(["ru", "su", "xn--p1ai"]);

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

async function loadBootstrap(doFetch: typeof fetch): Promise<Map<string, string>> {
  try {
    const res = await doFetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseBootstrap(await res.json());
  } catch (e) {
    throw new Error(`cannot load the RDAP bootstrap ${BOOTSTRAP_URL}: ${(e as Error).message}`);
  }
}

/** RDAP: 200 taken, 404 FREE, 429 waits Retry-After and retries, anything else ERR. */
async function rdapStage(domains: string[], parallel: number, base: Map<string, string>, o: WhoisOpts) {
  const doFetch = (o.fetcher ?? defaultFetcher)();
  const one = async (domain: string): Promise<string> => {
    const url = base.get(zoneOf(domain))!; // check() sends only bootstrap zones here
    for (let attempt = 0; attempt < 3; attempt++) {
      let wait = o.retryMs ?? 2000;
      try {
        const res = await doFetch(`${url}domain/${asciiDomain(domain)}`, { signal: AbortSignal.timeout(20_000) });
        await res.body?.cancel();
        if (res.status === 200) return `taken-rdap ${domain}`;
        if (res.status === 404) return `FREE ${domain}`;
        if (res.status !== 429) break;
        wait = Math.min(retryAfterMs(res.headers.get("retry-after")) ?? wait, 60_000);
      } catch { /* timeout or network error: retry */ }
      if (attempt < 2) await new Promise((r) => setTimeout(r, wait)); // no wait after the last try
    }
    return `ERR ${domain}`;
  };
  return await pool(domains, parallel, one);
}

/** Port 43 stage: server from whois.iana.org (once per zone), then the registry's own answer. */
export async function whois43Stage(domains: string[], parallel: number, query: Query = whoisQuery): Promise<string[]> {
  const servers = new Map<string, Promise<string | undefined>>();
  const serverOf = (zone: string) => {
    let s = servers.get(zone);
    if (!s) {
      s = query("whois.iana.org", zone).then(parseServer);
      s.then((h) => h || console.error(`no whois server for .${zone}: its names stay UNKNOWN`), () => {});
      servers.set(zone, s);
    }
    return s;
  };
  const one = async (domain: string): Promise<string> => {
    try {
      const host = await serverOf(zoneOf(domain));
      if (!host) return `UNKNOWN ${domain}`;
      const w = parseWhois43(await query(host, asciiDomain(domain)));
      if (w.kind === "free") return `FREE ${domain}`;
      if (w.kind === "taken") return `taken-whois ${domain}${w.state ? ` (${w.state})` : ""}`;
      return `${w.kind === "unknown" ? "UNKNOWN" : "ERR"} ${domain}`;
    } catch {
      return `ERR ${domain}`;
    }
  };
  return await pool(domains, parallel, one);
}

/** Check full domains; returns sorted result lines. Throws if a needed RDAP bootstrap cannot be loaded. */
export async function check(domains: string[], parallel: number, o: WhoisOpts = {}): Promise<string[]> {
  const needRdap = domains.some((d) => !WHOIS_RU.has(zoneOf(d)));
  const base = needRdap ? await loadBootstrap((o.fetcher ?? defaultFetcher)()) : new Map<string, string>();
  const dns = await pool(domains, 40, async (d) => [d, await delegated(asciiDomain(d), o.resolve)] as const);
  const rest = dns.filter(([, d]) => !d).map(([n]) => n);
  const taken = dns.filter(([, d]) => d).map(([n]) => `taken-delegated ${n}`);
  const ru = rest.filter((d) => WHOIS_RU.has(zoneOf(d)));
  const others = rest.filter((d) => !WHOIS_RU.has(zoneOf(d)));
  return sortLines([
    ...taken,
    ...await whoisStage(ru, parallel, o),
    ...await rdapStage(others.filter((d) => base.has(zoneOf(d))), parallel, base, o),
    ...await whois43Stage(others.filter((d) => !base.has(zoneOf(d))), parallel, o.query),
  ]);
}
