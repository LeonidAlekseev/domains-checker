import { assertEquals, assertRejects } from "@std/assert";
import {
  asciiDomain,
  check,
  delegated,
  parseBootstrap,
  parseNames,
  parseWhois,
  retryAfterMs,
  sortLines,
  toDomains,
  whoisStage,
  zoneOf,
} from "../src/check.ts";

Deno.test("parseNames: separators, lowercase, filter, dedupe; dotted names and IDN kept", () => {
  assertEquals(parseNames("Teef zvom,teef\nA-1\r\nbad.name x_y ü a..b .c d.\n"), [
    "teef",
    "zvom",
    "a-1",
    "bad.name",
    "ü",
  ]);
  assertEquals(parseNames("тест.рф"), ["тест.рф"]);
  assertEquals(parseNames(""), []);
});

Deno.test("toDomains: dotless names get every zone, dotted names stay as is, deduped", () => {
  assertEquals(toDomains(["teef", "a.org", "teef.ru"], ["ru", "com"]), [
    "teef.ru",
    "teef.com",
    "a.org",
  ]);
});

Deno.test("asciiDomain and zoneOf use punycode", () => {
  assertEquals(asciiDomain("тест.рф"), "xn--e1aybc.xn--p1ai");
  assertEquals(zoneOf("тест.рф"), "xn--p1ai");
  assertEquals(zoneOf("a.b.com"), "com");
});

Deno.test("parseBootstrap: tld -> base url, trailing slash ensured", () => {
  const m = parseBootstrap({
    services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]], [["app"], [
      "https://rdap.nic.google",
    ]]],
  });
  assertEquals(m.get("com"), "https://rdap.verisign.com/com/v1/");
  assertEquals(m.get("net"), "https://rdap.verisign.com/com/v1/");
  assertEquals(m.get("app"), "https://rdap.nic.google/");
  assertEquals(m.get("ru"), undefined);
});

Deno.test("retryAfterMs: seconds, http date, junk", () => {
  assertEquals(retryAfterMs("3", 0), 3000);
  assertEquals(retryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 0), 5000);
  assertEquals(retryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 9000), 0);
  assertEquals(retryAfterMs("soon", 0), undefined);
  assertEquals(retryAfterMs(null, 0), undefined);
});

Deno.test("parseWhois: free", () => {
  assertEquals(parseWhois("<p>Домен <b>свободен</b></p>"), { kind: "free" });
});

Deno.test("parseWhois: taken uses first state line", () => {
  const html = "<pre>domain: X.RU\nstate:  REGISTERED, DELEGATED, VERIFIED\nstate: other</pre>";
  assertEquals(parseWhois(html), { kind: "taken", state: "REGISTERED, DELEGATED, VERIFIED" });
});

Deno.test("parseWhois: captcha and unknown", () => {
  assertEquals(parseWhois("<p>Мы защиту от роботов включили</p>"), { kind: "captcha" });
  assertEquals(parseWhois("<html>oops</html>"), { kind: "unknown" });
});

Deno.test("sortLines is byte order", () => {
  assertEquals(sortLines(["taken-whois b", "FREE z", "ERR a", "FREE a"]), [
    "ERR a",
    "FREE a",
    "FREE z",
    "taken-whois b",
  ]);
});

Deno.test("delegated: NS answer means delegated, one attempt", async () => {
  let calls = 0;
  assertEquals(await delegated("a", () => (calls++, Promise.resolve())), true);
  assertEquals(calls, 1);
});

Deno.test("delegated: NotFound is final, no retry", async () => {
  let calls = 0;
  assertEquals(await delegated("a", () => (calls++, Promise.reject(new Deno.errors.NotFound()))), false);
  assertEquals(calls, 1);
});

Deno.test("delegated: timeout retried once, then not delegated", async () => {
  let calls = 0;
  const timeout = () => (calls++, Promise.reject(new DOMException("t", "TimeoutError")));
  assertEquals(await delegated("a", timeout), false);
  assertEquals(calls, 2);
});

Deno.test("delegated: second attempt can succeed", async () => {
  let calls = 0;
  const flaky = () => ++calls === 1 ? Promise.reject(new DOMException("t", "TimeoutError")) : Promise.resolve();
  assertEquals(await delegated("a", flaky), true);
});

// --- captcha flow: injected fetch and prompt, no network ---

const FREE = "<p>свободен</p>";
const CAPTCHA = "<p>защиту от роботов</p>";
const page = (html: string) => Promise.resolve(new Response(html));

/** Fake fetcher: `serve(proxy, url)` returns the page; every request is logged as "proxy|url". */
function fake(serve: (proxy: string | undefined, url: string, n: number) => string) {
  const log: string[] = [];
  const fetcher = (proxy?: string) => (url: string | URL | Request) => {
    log.push(`${proxy ?? "-"}|${url}`);
    return page(serve(proxy, String(url), log.length));
  };
  return { log, fetcher: fetcher as unknown as (proxy?: string) => typeof fetch };
}

const quiet = { retryMs: 0 };

Deno.test("whoisStage: captcha then 'continue' resumes and keeps earlier results", async () => {
  let blocked = true;
  const { log, fetcher } = fake((_p, url) => url.includes("/b.ru") && blocked ? CAPTCHA : FREE);
  const prompts: string[] = [];
  const out = await whoisStage(["a.ru", "b.ru", "c.ru"], 1, {
    ...quiet,
    fetcher,
    prompt: (link) => (prompts.push(link), blocked = false, Promise.resolve("continue")),
  });
  assertEquals(prompts, ["https://whois.ru/b.ru"]);
  assertEquals(out, ["FREE a.ru", "FREE b.ru", "FREE c.ru"]);
  assertEquals(log.length, 4); // a, b (captcha), b, c
});

Deno.test("whoisStage: 'stop' marks unchecked names ERR and sends no more requests", async () => {
  const { log, fetcher } = fake((_p, url) => url.includes("/b.ru") ? CAPTCHA : FREE);
  const out = await whoisStage(["a.ru", "b.ru", "c.ru", "d.ru"], 1, {
    ...quiet,
    fetcher,
    prompt: () => Promise.resolve("stop"),
  });
  assertEquals(out, ["FREE a.ru", "ERR b.ru", "ERR c.ru", "ERR d.ru"]);
  assertEquals(log.length, 2);
});

Deno.test("whoisStage: no terminal stops", async () => {
  const { log, fetcher } = fake(() => CAPTCHA);
  const out = await whoisStage(["a.ru", "b.ru"], 1, {
    ...quiet,
    fetcher,
    prompt: () => Promise.resolve("no-terminal"),
  });
  assertEquals(out, ["ERR a.ru", "ERR b.ru"]);
  assertEquals(log.length, 1);
});

Deno.test("whoisStage: proxy rotation, no prompt while proxies remain; then prompt", async () => {
  const { log, fetcher } = fake((proxy) => proxy === "p2" ? FREE : CAPTCHA);
  let prompted = 0;
  const out = await whoisStage(["a.ru"], 1, {
    ...quiet,
    fetcher,
    proxies: ["p1", "p2"],
    prompt: () => (prompted++, Promise.resolve("stop")),
  });
  assertEquals(out, ["FREE a.ru"]);
  assertEquals(log, ["-|https://whois.ru/a.ru", "p1|https://whois.ru/a.ru", "p2|https://whois.ru/a.ru"]);
  assertEquals(prompted, 0);

  const all = fake(() => CAPTCHA);
  const out2 = await whoisStage(["a.ru"], 1, {
    ...quiet,
    fetcher: all.fetcher,
    proxies: ["p1"],
    prompt: () => (prompted++, Promise.resolve("stop")),
  });
  assertEquals(out2, ["ERR a.ru"]);
  assertEquals(prompted, 1);
});

Deno.test("whoisStage: captcha again after Enter asks again", async () => {
  let n = 0;
  const { fetcher } = fake(() => ++n <= 2 ? CAPTCHA : FREE);
  let prompted = 0;
  const out = await whoisStage(["a.ru"], 1, {
    ...quiet,
    fetcher,
    prompt: () => (prompted++, Promise.resolve("continue")),
  });
  assertEquals(out, ["FREE a.ru"]);
  assertEquals(prompted, 2);
});

Deno.test("whoisStage: parallel workers share one prompt and start nothing while it is open", async () => {
  let blocked = true;
  const { log, fetcher } = fake(() => blocked ? CAPTCHA : FREE);
  let prompted = 0;
  const out = await whoisStage(["a.ru", "b.ru", "c.ru", "d.ru"], 4, {
    ...quiet,
    fetcher,
    prompt: async () => {
      prompted++;
      await new Promise((r) => setTimeout(r, 20));
      assertEquals(log.length, 4); // only the 4 in-flight requests, nothing new during the prompt
      blocked = false;
      return "continue";
    },
  });
  assertEquals(out, ["FREE a.ru", "FREE b.ru", "FREE c.ru", "FREE d.ru"]);
  assertEquals(prompted, 1);
});

Deno.test("check: delegated names are kept when whois stops", async () => {
  const { fetcher } = fake(() => CAPTCHA);
  const out = await check(["x.ru", "y.ru"], 1, {
    ...quiet,
    fetcher,
    resolve: (d) => d === "x.ru" ? Promise.resolve() : Promise.reject(new Deno.errors.NotFound()),
    prompt: () => Promise.resolve("stop"),
  });
  assertEquals(out, ["ERR y.ru", "taken-delegated x.ru"]);
});

// --- RDAP stage: injected fetch, no network ---

const BOOTSTRAP = { services: [[["com", "app"], ["https://rdap.example/v1/"]]] };
const notDelegated = () => Promise.reject(new Deno.errors.NotFound());

/** Fake fetcher serving the bootstrap and RDAP answers from `answer(url, n)`. */
function rdapFake(answer: (url: string, n: number) => Response) {
  const log: string[] = [];
  const f = ((url: string | URL | Request) => {
    log.push(String(url));
    return Promise.resolve(
      String(url).includes("iana.org") ? Response.json(BOOTSTRAP) : answer(String(url), log.length),
    );
  }) as typeof fetch;
  return { log, opts: { ...quiet, fetcher: () => f, resolve: notDelegated } };
}

Deno.test("check: RDAP 200 taken, 404 FREE, other ERR; a zone outside the bootstrap goes to port 43 whois", async () => {
  const { log, opts } = rdapFake((url) =>
    new Response(null, { status: url.endsWith("/a.com") ? 200 : url.endsWith("/b.com") ? 404 : 500 })
  );
  const asked: string[] = [];
  const query = (
    host: string,
    q: string,
  ) => (asked.push(`${host}|${q}`),
    Promise.resolve(host.endsWith("iana.org") ? "whois: whois.nic.io" : "No Data Found"));
  const out = await check(["a.com", "b.com", "c.com", "d.io"], 1, { ...opts, query });
  assertEquals(out, ["ERR c.com", "FREE b.com", "FREE d.io", "taken-rdap a.com"]);
  assertEquals(asked, ["whois.iana.org|io", "whois.nic.io|d.io"]);
  assertEquals(log.filter((u) => u.includes("rdap.example")).length, 3); // io: no RDAP request
  assertEquals(log.filter((u) => u.includes("iana.org")).length, 1); // bootstrap fetched once
});

Deno.test("check: RDAP uses punycode, output keeps the typed name", async () => {
  const { log, opts } = rdapFake(() => new Response(null, { status: 404 }));
  assertEquals(await check(["тест.com"], 1, opts), ["FREE тест.com"]);
  assertEquals(log[1], "https://rdap.example/v1/domain/xn--e1aybc.com");
});

Deno.test("check: RDAP 429 honours Retry-After and retries, then succeeds", async () => {
  const { log, opts } = rdapFake((_u, n) =>
    n <= 2 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : new Response(null, { status: 404 })
  );
  assertEquals(await check(["a.com"], 1, opts), ["FREE a.com"]);
  assertEquals(log.length, 3); // bootstrap + 429 + 404
});

Deno.test("check: RDAP 429 forever gives ERR", async () => {
  const { opts } = rdapFake(() => new Response(null, { status: 429, headers: { "retry-after": "0" } }));
  assertEquals(await check(["a.com"], 1, opts), ["ERR a.com"]);
});

Deno.test("check: bootstrap unavailable is an error, not UNKNOWN", async () => {
  const opts = {
    ...quiet,
    resolve: notDelegated,
    fetcher: () => (() => Promise.resolve(new Response("x", { status: 503 }))) as typeof fetch,
  };
  await assertRejects(() => check(["a.com"], 1, opts), Error, "bootstrap");
});

Deno.test("check: only .ru needs no bootstrap", async () => {
  const { fetcher } = fake(() => FREE);
  assertEquals(await check(["a.ru"], 1, { ...quiet, fetcher, resolve: notDelegated }), ["FREE a.ru"]);
});

Deno.test("check: .su and .рф go to whois.ru, not to port 43", async () => {
  const { log, fetcher } = fake(() => FREE);
  const query = () => Promise.reject(new Error("port 43 must not be used"));
  const out = await check(["a.su", "щ.рф"], 1, { ...quiet, fetcher, resolve: notDelegated, query });
  assertEquals(out, ["FREE a.su", "FREE щ.рф"]);
  assertEquals(log.map((l) => l.split("/").pop()), ["a.su", "xn--y1a.xn--p1ai"]);
});
