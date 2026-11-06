import { assertEquals, assertRejects } from "@std/assert";
import { check } from "../src/check.ts";
import { defaultOut, run } from "../src/run.ts";
import { createUi } from "../src/ui.ts";

// --- injected fetch and resolver, no network ---

const notDelegated = () => Promise.reject(new Deno.errors.NotFound());
const verdict = (url: string) => `<p>Домен <b>${new URL(url).pathname.slice(1)}</b> свободен</p>`;
const BOOTSTRAP = { services: [[["com"], ["https://rdap.example/v1/"]]] };

/** whois.ru says free for all; a url containing "hang" never answers; RDAP says 404; every request is logged. */
function network(onRequest: (url: string) => void = () => {}) {
  const log: string[] = [];
  const f = ((u: string) => {
    const url = String(u);
    log.push(url);
    onRequest(url);
    if (url.includes("hang")) return new Promise(() => {});
    if (url.includes("iana.org")) return Promise.resolve(Response.json(BOOTSTRAP));
    if (url.includes("rdap")) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(verdict(url)));
  }) as unknown as typeof fetch;
  return { log, opts: { retryMs: 0, fetcher: () => f, resolve: notDelegated } };
}

Deno.test("check: stages and results are reported as they happen", async () => {
  const events: string[] = [];
  const { opts } = network();
  const lines = await check(["a.ru", "b.com", "c.com"], 1, {
    ...opts,
    resolve: (d) => d === "c.com" ? Promise.resolve() : notDelegated(),
    onStage: (name, total) => events.push(`${name}/${total}`),
    onResult: (line) => events.push(line ?? "-"),
  });
  assertEquals(lines, ["FREE a.ru", "FREE b.com", "taken-delegated c.com"]);
  assertEquals(events, ["DNS/3", "-", "-", "taken-delegated c.com", "whois.ru/1", "FREE a.ru", "RDAP/1", "FREE b.com"]);
});

Deno.test("check: a stop mid-run keeps earlier results, abandons requests in flight, skips later stages", async () => {
  const stop = new AbortController();
  const { log, opts } = network((url) => url.includes("hang") && stop.abort());
  const seen: string[] = [];
  const lines = await check(["a.ru", "hang.ru", "z.ru", "b.com"], 1, {
    ...opts,
    signal: stop.signal,
    onStage: (name) => seen.push(name),
  });
  assertEquals(lines, ["FREE a.ru"]);
  assertEquals(seen, ["DNS", "whois.ru"]);
  assertEquals(log.filter((u) => !u.includes("iana.org")).length, 2); // z.ru and RDAP never asked
});

Deno.test("check: work abandoned by a stop starts no new request and no prompt", async () => {
  for (
    const [domain, answer] of [
      ["a.ru", () => Promise.reject(new Error("reset"))], // whois.ru retry
      ["b.ru", () => Promise.resolve(new Response("<p>защиту от роботов</p>"))], // captcha after the stop
      ["c.com", () => Promise.reject(new Error("reset"))], // RDAP retry
    ] as const
  ) {
    const stop = new AbortController();
    let land = () => {};
    const landed = new Promise<void>((r) => land = r);
    const log: string[] = [];
    const f = (async (u: string) => {
      if (String(u).includes("iana.org")) return Response.json(BOOTSTRAP);
      log.push(String(u));
      stop.abort();
      await new Promise((r) => setTimeout(r, 1)); // lands after check() has returned
      land();
      return answer();
    }) as unknown as typeof fetch;
    let asked = false;
    const prompt = () => (asked = true, Promise.resolve("continue" as const));
    const opts = { retryMs: 0, fetcher: () => f, resolve: notDelegated, signal: stop.signal, prompt };
    assertEquals(await check([domain], 1, opts), []);
    await landed;
    await new Promise((r) => setTimeout(r, 5));
    assertEquals([log.length, asked], [1, false], domain);
  }
});

Deno.test("check: a stop ends an open captcha prompt", async () => {
  const stop = new AbortController();
  const { opts } = network();
  const f = (() => Promise.resolve(new Response("<p>защиту от роботов</p>"))) as unknown as typeof fetch;
  const lines = await check(["a.ru"], 1, {
    ...opts,
    fetcher: () => f,
    signal: stop.signal,
    prompt: () => (stop.abort(), new Promise(() => {})),
  });
  assertEquals(lines, []);
});

Deno.test("check: a stop during the RDAP bootstrap ends the run", async () => {
  const stop = new AbortController();
  const f = (() => (stop.abort(), new Promise(() => {}))) as unknown as typeof fetch;
  assertEquals(await check(["a.com"], 1, { fetcher: () => f, resolve: notDelegated, signal: stop.signal }), []);
});

Deno.test("check: warnings go through the warn hook", async () => {
  const notes: string[] = [];
  const query = () => Promise.resolve("no whois line here");
  await check(["a.xx"], 1, { ...network().opts, query, warn: (m) => notes.push(m) });
  assertEquals(notes, ["no whois server for .xx: its names stay UNKNOWN"]);
});

// --- run: the whole output of a check, real file, fake terminal ---

/** A fake terminal: stderr and stdout captured; `live` means stderr is a terminal. */
function terminal(live: boolean, opts: { color?: boolean; stdoutTty?: boolean; columns?: number } = {}) {
  const err: string[] = [];
  const out: string[] = [];
  return {
    err,
    out,
    opts: {
      term: {
        live,
        color: opts.color ?? true,
        columns: () => opts.columns ?? 100,
        write: (s: string) => void err.push(s),
      },
      print: (lines: string[]) => (out.push(...lines), Promise.resolve()),
      stdoutTty: opts.stdoutTty ?? false,
    },
  };
}

const tempOut = async () => `${await Deno.makeTempDir()}/free.txt`;
const input = (domains: string[], unknown: string[] = []) => ({ names: domains.length, domains, unknown });
const ESC = "\x1b";

Deno.test("run: each FREE reaches the file before the run goes on", async () => {
  const out = await tempOut();
  let seen = "";
  const { opts } = network((url) => url.includes("b.ru") && (seen = Deno.readTextFileSync(out)));
  await run(input(["a.ru", "b.ru"]), 1, { ...opts, ...terminal(false).opts, out });
  assertEquals(seen, "a.ru\n");
  assertEquals(await Deno.readTextFile(out), "a.ru\nb.ru\n");
});

Deno.test("run: an existing file is appended to; no FREE leaves no file", async () => {
  const out = await tempOut();
  await Deno.writeTextFile(out, "old.ru\n");
  await run(input(["a.ru"]), 1, { ...network().opts, ...terminal(false).opts, out });
  assertEquals(await Deno.readTextFile(out), "old.ru\na.ru\n");

  const none = await tempOut();
  const taken = { ...network().opts, resolve: () => Promise.resolve() };
  await run(input(["a.ru"]), 1, { ...taken, ...terminal(false).opts, out: none });
  await assertRejects(() => Deno.stat(none), Deno.errors.NotFound);
});

Deno.test("run: a file that cannot be written warns and keeps the results", async () => {
  const t = terminal(false);
  const code = await run(input(["a.ru"]), 1, { ...network().opts, ...t.opts, out: "/nonexistent-dir/free.txt" });
  assertEquals(code, 0);
  assertEquals(t.out, ["FREE a.ru"]);
  assertEquals(t.err.join("").includes("/nonexistent-dir/free.txt"), true);
});

Deno.test("run: pipe mode prints the sorted lines of old and no escape codes", async () => {
  const t = terminal(false);
  const code = await run(input(["b.ru", "a.ru"], ["x.y.z"]), 1, {
    ...network().opts,
    resolve: (d) => d === "b.ru" ? Promise.resolve() : notDelegated(),
    ...t.opts,
    out: await tempOut(),
  });
  assertEquals(code, 0);
  assertEquals(t.out, ["FREE a.ru", "UNKNOWN x.y.z", "taken-delegated b.ru"]);
  assertEquals(t.err, [
    "1 name(s) with more than one dot are UNKNOWN (not checked), e.g. x.y.z; " +
    "only name.zone or name.<--tld zone> are checked\n",
  ]);
});

Deno.test("run: stdout and stderr on a terminal: FREE is shown live, not repeated, summary last", async () => {
  const t = terminal(true, { stdoutTty: true, color: false });
  const out = await tempOut();
  await run(input(["a.ru", "b.ru"]), 1, {
    ...network().opts,
    resolve: (d) => d === "b.ru" ? Promise.resolve() : notDelegated(),
    ...t.opts,
    out,
  });
  assertEquals(t.out, ["taken-delegated b.ru"]);
  const err = t.err.join("");
  assertEquals(err.includes("a.ru\n"), true);
  assertEquals(err.includes("domains-checker"), true);
  const summary = t.err.at(-1)!;
  assertEquals(summary.includes(out), true);
});

Deno.test("run: stdout on a terminal but stderr redirected: FREE is still printed", async () => {
  const t = terminal(false, { stdoutTty: true });
  await run(input(["a.ru"]), 1, { ...network().opts, ...t.opts, out: await tempOut() });
  assertEquals(t.out, ["FREE a.ru"]);
});

Deno.test("run: stdout piped from a terminal session keeps every line", async () => {
  const t = terminal(true);
  await run(input(["a.ru"]), 1, { ...network().opts, ...t.opts, out: await tempOut() });
  assertEquals(t.out, ["FREE a.ru"]);
});

Deno.test("run: an interrupt keeps FREE, reports what was not checked, exit code 130", async () => {
  const stop = new AbortController();
  const out = await tempOut();
  const t = terminal(false);
  const { opts } = network((url) => url.includes("hang") && stop.abort());
  const code = await run(input(["a.ru", "hang.ru", "z.ru", "b.com"]), 1, {
    ...opts,
    ...t.opts,
    signal: stop.signal,
    out,
  });
  assertEquals(code, 130);
  assertEquals(t.out, ["FREE a.ru"]);
  assertEquals(await Deno.readTextFile(out), "a.ru\n");
  const err = t.err.join("");
  assertEquals(err.includes("3 not checked"), true);
  assertEquals(err.includes(ESC), false);
});

Deno.test("run: an RDAP bootstrap failure is reported, exit code 1", async () => {
  const f = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
  const t = terminal(true);
  const code = await run(input(["a.com"]), 1, { fetcher: () => f, resolve: notDelegated, ...t.opts, out: "x" });
  assertEquals(code, 1);
  assertEquals(t.err.join("").includes("cannot load the RDAP bootstrap"), true);
});

Deno.test("run: the captcha prompt clears the bar, the bar returns after it", async () => {
  let answered = false;
  const fetcher = () =>
    ((url: string) =>
      Promise.resolve(new Response(answered ? verdict(url) : "<p>защиту от роботов</p>"))) as unknown as typeof fetch;
  const t = terminal(true);
  let atPrompt = "";
  await run(input(["a.ru"]), 1, {
    resolve: notDelegated,
    fetcher,
    retryMs: 0,
    ...t.opts,
    out: await tempOut(),
    prompt: (_link, say) => {
      say("ask");
      atPrompt = t.err.join("");
      answered = true;
      return Promise.resolve("continue");
    },
  });
  assertEquals(atPrompt.endsWith(`ask\n`), true);
  assertEquals(atPrompt.includes(`${ESC}[2K`), true);
  const after = t.err.join("").slice(atPrompt.length);
  assertEquals(after.includes("whois.ru"), true);
});

// --- the real CLI, no network: a name with two dots is never looked up ---

Deno.test("cli: pipe mode stdout bytes and plain stderr", async () => {
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-env=CONS,VOWS,WHOIS_P", `${import.meta.dirname}/../src/main.ts`, "check"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("b.x.y\na.x.y\n"));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  const dec = new TextDecoder();
  assertEquals(code, 0);
  assertEquals(dec.decode(stdout), "UNKNOWN a.x.y\nUNKNOWN b.x.y\n");
  assertEquals(
    dec.decode(stderr),
    "2 name(s) with more than one dot are UNKNOWN (not checked), e.g. b.x.y; " +
      "only name.zone or name.<--tld zone> are checked\n",
  );
});

Deno.test("cli: check exits quietly with 0 when stdout is closed early", async () => {
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-env=CONS,VOWS,WHOIS_P", `${import.meta.dirname}/../src/main.ts`, "check"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  await child.stdout.cancel(); // like `| head` that has already left
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("a.x.y\n"));
  await writer.close();
  const { code } = await child.status;
  assertEquals((await stderr).includes("Broken pipe"), false);
  assertEquals(code, 0);
});

// --- defaultOut ---

Deno.test("defaultOut: free-YYYYMMDD-HHMMSS.txt in local time", () => {
  assertEquals(defaultOut(new Date(2026, 0, 2, 3, 4, 5)), "free-20260102-030405.txt");
});

// --- ui: frames ---

const ansi = new RegExp(`${ESC}\\[[0-9;]*[mK]`, "g");

function frames(opts: { color?: boolean; columns?: number; live?: boolean }) {
  const t = terminal(opts.live ?? true, opts);
  const ui = createUi(t.opts.term);
  ui.stage("whois.ru", 200);
  for (let i = 0; i < 150; i++) ui.result(i % 3 ? `taken-whois a${i}.ru (x)` : `FREE a${i}.ru`);
  ui.stop();
  return t.err;
}

Deno.test("ui: the bar never wraps, at any width", () => {
  for (const columns of [1, 2, 5, 20, 40, 60, 80, 200]) {
    for (const frame of frames({ columns })) {
      for (const line of frame.replace(ansi, "").split(/[\r\n]/)) {
        if (line.startsWith("★")) continue; // a FREE line is a finished line, not redrawn
        assertEquals(line.length < Math.max(columns, 2), true, `${columns}: ${line}`);
      }
    }
  }
});

Deno.test("ui: the bar shows done, total, percent, ETA and counters", () => {
  const last = frames({ columns: 100 }).at(-2)!.replace(ansi, "");
  assertEquals(/ 150\/200 75% ETA .* FREE 50 · taken 100/.test(last), true, last);
});

Deno.test("ui: NO_COLOR removes colours and keeps the live redraw", () => {
  const all = frames({ color: false }).join("");
  assertEquals(all.replaceAll(`${ESC}[2K`, "").includes(ESC), false);
  assertEquals(all.includes("\r"), true);
});

Deno.test("ui: a finished stage collapses to one ✔ line", () => {
  const t = terminal(true);
  const ui = createUi(t.opts.term);
  ui.stage("DNS", 1);
  ui.result();
  ui.stop();
  assertEquals(/✔.*DNS.*s/.test(t.err.at(-1)!), true, t.err.at(-1));
});
