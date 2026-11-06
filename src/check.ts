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

export type Resolver = (domain: string, signal: AbortSignal) => Promise<unknown>;

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

export type CaptchaChoice = "continue" | "stop" | "no-terminal";

export type WhoisOpts = {
  /** Returns the fetch to use, optionally through a proxy URL. */
  fetcher?: (proxy?: string) => typeof fetch;
  /** Proxies to rotate through, one per captcha, before asking the user. */
  proxies?: string[];
  /** Ask the user to pass the captcha at `link`. */
  prompt?: (link: string) => Promise<CaptchaChoice>;
  resolve?: Resolver;
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
export async function whoisStage(names: string[], parallel: number, o: WhoisOpts = {}): Promise<string[]> {
  const fetcher = o.fetcher ?? defaultFetcher;
  const proxies = [...o.proxies ?? []];
  const prompt = o.prompt ?? (() => Promise.resolve<CaptchaChoice>("no-terminal"));
  let doFetch = fetcher();
  let epoch = 0; // bumped after each resolved captcha; a captcha from an older epoch is already handled
  let stopped = false;
  let resolving: Promise<void> | undefined;

  const resolveCaptcha = (name: string, seen: number) => {
    if (stopped || seen !== epoch) return resolving;
    resolving ??= (async () => {
      const proxy = proxies.shift();
      if (proxy) {
        console.error(`captcha: whois.ru blocked, switching to proxy ${proxy}`);
        doFetch = fetcher(proxy);
      } else {
        const choice = await prompt(`https://whois.ru/${name}.ru`);
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

  const one = async (name: string): Promise<string> => {
    for (let attempt = 0; attempt < 3;) {
      await resolving;
      if (stopped) break;
      const seen = epoch;
      try {
        const res = await doFetch(`https://whois.ru/${name}.ru`, { signal: AbortSignal.timeout(20_000) });
        const w = parseWhois(await res.text());
        if (w.kind === "free") return `FREE ${name}`;
        if (w.kind === "taken") return `taken-whois ${name} (${w.state})`;
        if (w.kind === "captcha") {
          await resolveCaptcha(name, seen);
          continue; // a captcha is not a failed attempt
        }
      } catch { /* timeout or network error: retry */ }
      attempt++;
      await new Promise((r) => setTimeout(r, o.retryMs ?? 2000));
    }
    return `ERR ${name}`;
  };
  return await pool(names, parallel, one);
}

/** Check names; returns sorted result lines. */
export async function check(names: string[], whoisParallel: number, o: WhoisOpts = {}): Promise<string[]> {
  const dns = await pool(names, 40, async (n) => [n, await delegated(n, o.resolve)] as const);
  const rest = dns.filter(([, d]) => !d).map(([n]) => n);
  const taken = dns.filter(([, d]) => d).map(([n]) => `taken-delegated ${n}`);
  return sortLines([...taken, ...await whoisStage(rest, whoisParallel, o)]);
}
