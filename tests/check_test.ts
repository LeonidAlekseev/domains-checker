import { assertEquals } from "@std/assert";
import { check, delegated, parseNames, parseWhois, sortLines, whoisStage } from "../src/check.ts";

Deno.test("parseNames: separators, lowercase, filter, dedupe", () => {
  assertEquals(parseNames("Teef zvom,teef\nA-1\r\nbad.name x_y ü\n"), ["teef", "zvom", "a-1"]);
  assertEquals(parseNames(""), []);
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
  const out = await whoisStage(["a", "b", "c"], 1, {
    ...quiet,
    fetcher,
    prompt: (link) => (prompts.push(link), blocked = false, Promise.resolve("continue")),
  });
  assertEquals(prompts, ["https://whois.ru/b.ru"]);
  assertEquals(out, ["FREE a", "FREE b", "FREE c"]);
  assertEquals(log.length, 4); // a, b (captcha), b, c
});

Deno.test("whoisStage: 'stop' marks unchecked names ERR and sends no more requests", async () => {
  const { log, fetcher } = fake((_p, url) => url.includes("/b.ru") ? CAPTCHA : FREE);
  const out = await whoisStage(["a", "b", "c", "d"], 1, { ...quiet, fetcher, prompt: () => Promise.resolve("stop") });
  assertEquals(out, ["FREE a", "ERR b", "ERR c", "ERR d"]);
  assertEquals(log.length, 2);
});

Deno.test("whoisStage: no terminal stops", async () => {
  const { log, fetcher } = fake(() => CAPTCHA);
  const out = await whoisStage(["a", "b"], 1, { ...quiet, fetcher, prompt: () => Promise.resolve("no-terminal") });
  assertEquals(out, ["ERR a", "ERR b"]);
  assertEquals(log.length, 1);
});

Deno.test("whoisStage: proxy rotation, no prompt while proxies remain; then prompt", async () => {
  const { log, fetcher } = fake((proxy) => proxy === "p2" ? FREE : CAPTCHA);
  let prompted = 0;
  const out = await whoisStage(["a"], 1, {
    ...quiet,
    fetcher,
    proxies: ["p1", "p2"],
    prompt: () => (prompted++, Promise.resolve("stop")),
  });
  assertEquals(out, ["FREE a"]);
  assertEquals(log, ["-|https://whois.ru/a.ru", "p1|https://whois.ru/a.ru", "p2|https://whois.ru/a.ru"]);
  assertEquals(prompted, 0);

  const all = fake(() => CAPTCHA);
  const out2 = await whoisStage(["a"], 1, {
    ...quiet,
    fetcher: all.fetcher,
    proxies: ["p1"],
    prompt: () => (prompted++, Promise.resolve("stop")),
  });
  assertEquals(out2, ["ERR a"]);
  assertEquals(prompted, 1);
});

Deno.test("whoisStage: captcha again after Enter asks again", async () => {
  let n = 0;
  const { fetcher } = fake(() => ++n <= 2 ? CAPTCHA : FREE);
  let prompted = 0;
  const out = await whoisStage(["a"], 1, {
    ...quiet,
    fetcher,
    prompt: () => (prompted++, Promise.resolve("continue")),
  });
  assertEquals(out, ["FREE a"]);
  assertEquals(prompted, 2);
});

Deno.test("whoisStage: parallel workers share one prompt and start nothing while it is open", async () => {
  let blocked = true;
  const { log, fetcher } = fake(() => blocked ? CAPTCHA : FREE);
  let prompted = 0;
  const out = await whoisStage(["a", "b", "c", "d"], 4, {
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
  assertEquals(out, ["FREE a", "FREE b", "FREE c", "FREE d"]);
  assertEquals(prompted, 1);
});

Deno.test("check: delegated names are kept when whois stops", async () => {
  const { fetcher } = fake(() => CAPTCHA);
  const out = await check(["x", "y"], 1, {
    ...quiet,
    fetcher,
    resolve: (d) => d === "x.ru" ? Promise.resolve() : Promise.reject(new Deno.errors.NotFound()),
    prompt: () => Promise.resolve("stop"),
  });
  assertEquals(out, ["ERR y", "taken-delegated x"]);
});
