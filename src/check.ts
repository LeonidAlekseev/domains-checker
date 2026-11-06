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

/**
 * A name without a dot is checked in every zone. A name with a dot is checkable if it has exactly one dot
 * or is `<label>.<zone>` for a --tld zone; every other name is `unknown`, and invalid hosts are dropped.
 */
export function toDomains(names: string[], zones: string[]): { domains: string[]; unknown: string[] } {
  const domains = new Set<string>();
  const unknown = new Set<string>();
  const inZone = (d: string) =>
    zones.map(asciiDomain).some((z) => d.endsWith(`.${z}`) && !d.slice(0, -z.length - 1).includes("."));
  for (const n of names) {
    for (const d of n.includes(".") ? [n] : zones.map((z) => `${n}.${z}`)) {
      const ascii = asciiDomain(d);
      if (!ascii) continue;
      (ascii.split(".").length === 2 || inZone(ascii) ? domains : unknown).add(d);
    }
  }
  return { domains: [...domains], unknown: [...unknown] };
}

/** `--tld` value to zones (leading dot stripped, lowercase); undefined if a zone is not dot-separated labels. */
export function parseZones(tld: string): string[] | undefined {
  const zones = tld.toLowerCase().split(",").map((z) => z.trim().replace(/^\./, ""));
  return zones.every((z) => /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*$/u.test(z)) ? zones : undefined;
}

/** A proxy URL for messages: user and password replaced by ***. */
export function maskProxy(proxy: string): string {
  try {
    const u = new URL(proxy);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    return u.href;
  } catch {
    return "<invalid proxy URL>";
  }
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

/**
 * Parse a whois.ru page: tags stripped, then captcha / first `state:` / the verdict
 * `Домен <name> свободен` for this very domain (the page shows .рф names in Unicode), in that order.
 */
export function parseWhois(html: string, domain: string): Whois {
  const lines = html.replace(/<[^>]*>/g, "\n").split("\n");
  if (lines.some((l) => l.includes("защиту от роботов"))) return { kind: "captcha" };
  const state = lines.find((l) => l.includes("state:"));
  if (state) return { kind: "taken", state: state.split(":")[1].trim() };
  const text = lines.join(" ").replace(/\s+/g, " ").toLowerCase();
  if ([domain, asciiDomain(domain)].some((d) => text.includes(`домен ${d.toLowerCase()} свободен`))) {
    return { kind: "free" };
  }
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
  /** Ask the user to pass the captcha at `link`, speaking through `say`. */
  prompt?: (link: string, say: (message: string) => void) => Promise<CaptchaChoice>;
  resolve?: Resolver;
  /** Port 43 whois query, replaceable in tests. */
  query?: Query;
  /** Wait between retries (also the default when a 429 has no Retry-After). */
  retryMs?: number;
  /** Abort: nothing new starts, requests in flight are abandoned, their names are left out of the result. */
  signal?: AbortSignal;
  /** Captcha, proxy and registry notes; console.error by default. */
  warn?: (message: string) => void;
  /** A stage with work to do starts. */
  onStage?: (name: string, total: number) => void;
  /** One item of the stage is done; no line for a name that goes on to the next stage. */
  onResult?: (line?: string) => void;
};

const defaultFetcher = (proxy?: string): typeof fetch => {
  if (!proxy) return fetch;
  const client = Deno.createHttpClient({ proxy: { url: proxy } }); // one client per proxy, so connections are reused
  return (url, init) => fetch(url, { ...init, client });
};

/** `work`, or undefined the moment `signal` aborts; whatever `work` was doing is abandoned. */
function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => resolve(undefined);
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Run one stage over `items`, reporting each result as it lands; on abort the unfinished items are left out. */
async function stage(
  name: string,
  items: string[],
  parallel: number,
  one: (item: string) => Promise<string | undefined>,
  o: WhoisOpts,
): Promise<string[]> {
  if (!items.length || o.signal?.aborted) return [];
  o.onStage?.(name, items.length);
  const lines = await pool(items, parallel, async (item) => {
    if (o.signal?.aborted) return undefined;
    const line = await untilAbort(one(item), o.signal);
    if (o.signal?.aborted) return undefined;
    o.onResult?.(line);
    return line;
  });
  return lines.filter((line) => line !== undefined);
}

/**
 * whois.ru stage. On the first captcha no new request starts (requests already in flight may finish)
 * until a proxy is swapped in or the user continues; on stop the unchecked names become ERR.
 */
export async function whoisStage(domains: string[], parallel: number, o: WhoisOpts = {}): Promise<string[]> {
  const fetcher = o.fetcher ?? defaultFetcher;
  const proxies = [...o.proxies ?? []];
  const prompt = o.prompt ?? (() => Promise.resolve<CaptchaChoice>("no-terminal"));
  const warn = o.warn ?? console.error;
  let doFetch = fetcher();
  let epoch = 0; // bumped after each resolved captcha; a captcha from an older epoch is already handled
  let stopped = false;
  let resolving: Promise<void> | undefined;
  o.signal?.addEventListener("abort", () => stopped = true);

  const resolveCaptcha = (domain: string, seen: number) => {
    if (stopped || seen !== epoch) return resolving;
    resolving ??= (async () => {
      const proxy = proxies.shift();
      if (proxy) {
        warn(`captcha: whois.ru blocked, switching to proxy ${maskProxy(proxy)}`);
        doFetch = fetcher(proxy);
      } else {
        let choice: CaptchaChoice;
        try {
          choice = await prompt(`https://whois.ru/${asciiDomain(domain)}`, warn);
        } catch {
          choice = "stop"; // a broken prompt must not loop
        }
        if (choice !== "continue") {
          stopped = true;
          warn(
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
        const w = parseWhois(await res.text(), domain);
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
  return await stage("whois.ru", domains, parallel, one, o);
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
    for (let attempt = 0; attempt < 3 && !o.signal?.aborted; attempt++) {
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
  return await stage("RDAP", domains, parallel, one, o);
}

/** Port 43 stage: server from whois.iana.org (once per zone), then the registry's own answer. */
export async function whois43Stage(
  domains: string[],
  parallel: number,
  query: Query = whoisQuery,
  o: WhoisOpts = {},
): Promise<string[]> {
  const warn = o.warn ?? console.error;
  const servers = new Map<string, Promise<string | undefined>>();
  const serverOf = (zone: string) => {
    let s = servers.get(zone);
    if (!s) {
      s = query("whois.iana.org", zone).then(parseServer);
      s.then(
        (h) => h || warn(`no whois server for .${zone}: its names stay UNKNOWN`),
        () => servers.delete(zone),
      );
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
  return await stage("port 43", domains, parallel, one, o);
}

/**
 * Check full domains; returns sorted result lines, on abort only the finished ones.
 * Throws if a needed RDAP bootstrap cannot be loaded.
 */
export async function check(domains: string[], parallel: number, o: WhoisOpts = {}): Promise<string[]> {
  const needRdap = domains.some((d) => !WHOIS_RU.has(zoneOf(d)));
  const base = needRdap
    ? await untilAbort(loadBootstrap((o.fetcher ?? defaultFetcher)()), o.signal)
    : new Map<string, string>();
  if (!base) return [];
  const rest: string[] = [];
  const taken = await stage("DNS", domains, 40, async (d) => {
    if (await delegated(asciiDomain(d), o.resolve)) return `taken-delegated ${d}`;
    rest.push(d);
  }, o);
  const ru = rest.filter((d) => WHOIS_RU.has(zoneOf(d)));
  const others = rest.filter((d) => !WHOIS_RU.has(zoneOf(d)));
  return sortLines([
    ...taken,
    ...await whoisStage(ru, parallel, o),
    ...await rdapStage(others.filter((d) => base.has(zoneOf(d))), parallel, base, o),
    ...await whois43Stage(others.filter((d) => !base.has(zoneOf(d))), parallel, o.query, o),
  ]);
}
