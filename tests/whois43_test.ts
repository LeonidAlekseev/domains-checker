import { assertEquals } from "@std/assert";
import { whois43Stage } from "../src/check.ts";
import { parseServer, parseWhois43 } from "../src/whois43.ts";

const fixture = (name: string) => Deno.readTextFileSync(new URL(`./fixtures/whois43/${name}.txt`, import.meta.url));

// Real responses captured live from each registry; the zone names double as the test names.
const FREE_ZONES = ["io", "co", "me", "sh", "la", "us", "de", "it", "be", "eu", "dk", "se", "at"];
const TAKEN_ZONES = [...FREE_ZONES, "su"];

for (const z of FREE_ZONES) {
  Deno.test(`parseWhois43: ${z} free sample`, () => assertEquals(parseWhois43(fixture(`${z}.free`)), { kind: "free" }));
}
for (const z of TAKEN_ZONES) {
  Deno.test(`parseWhois43: ${z} taken sample`, () => assertEquals(parseWhois43(fixture(`${z}.taken`)).kind, "taken"));
}

Deno.test("parseWhois43: state is taken from the status line when there is one", () => {
  assertEquals(parseWhois43(fixture("su.taken")), { kind: "taken", state: "REGISTERED, DELEGATED, VERIFIED" });
  assertEquals(parseWhois43(fixture("de.taken")), { kind: "taken", state: "connect" });
  assertEquals(parseWhois43(fixture("co.taken")), { kind: "taken", state: "clientTransferProhibited" });
  assertEquals(parseWhois43(fixture("be.taken")), { kind: "taken", state: "NOT AVAILABLE" });
  assertEquals(parseWhois43(fixture("se.taken")), { kind: "taken", state: "active" });
  assertEquals(parseWhois43(fixture("at.taken")), { kind: "taken" }); // no status line at all
});

Deno.test("parseWhois43: the state is one line without control characters", () => {
  const w = parseWhois43("Domain: a.de\nStatus: ok\u001b[31m\u0007 evil\r\nStatus: x");
  assertEquals(w, { kind: "taken", state: "ok[31m evil" });
});

Deno.test("parseWhois43: registry refusals and rate limits are 'limited', not free", () => {
  assertEquals(parseWhois43(fixture("ch.free")), { kind: "limited" });
  // synthetic texts in the wording the registries use
  for (
    const t of [
      "% Error: 55000000013 Connection refused; access control limit reached\n",
      "ERROR: Too many requests, try again later\n",
      "Your connection limit exceeded. Please slow down.\n",
      "% Query rate limit exceeded\n",
    ]
  ) assertEquals(parseWhois43(t), { kind: "limited" }, t);
});

Deno.test("parseWhois43: terms text mentioning limits or 'not found' mid-sentence changes nothing", () => {
  const w = parseWhois43(
    "Domain Name: x.io\nTerms: if too many queries are received, access is limited; not found is ok.\n",
  );
  assertEquals(w.kind, "taken");
});

Deno.test("parseWhois43: anything unrecognised is unknown, never free", () => {
  for (const t of ["", "\n\n", "Welcome to the registry!\n", "<html>502 Bad Gateway</html>", "Status: reserved\n"]) {
    assertEquals(parseWhois43(t), { kind: "unknown" }, t);
  }
});

Deno.test("parseWhois43: a reply that is both taken and free is unknown", () => {
  assertEquals(parseWhois43("Domain Name: x.io\nDomain not found.\n"), { kind: "unknown" });
  assertEquals(parseWhois43("No match for x.com\nDomain Name: X.COM\n"), { kind: "unknown" });
});

Deno.test("parseWhois43: 'not found' about something else than the domain is not free", () => {
  for (const t of ["Not found: invalid query\n", "Not found: nameserver\n", "% not found in the whole world\n"]) {
    assertEquals(parseWhois43(t), { kind: "unknown" }, t);
  }
});

Deno.test("parseServer: whois line from IANA", () => {
  assertEquals(parseServer("refer: x\nwhois:        whois.nic.io\nstatus: ACTIVE"), "whois.nic.io");
  assertEquals(parseServer("whois:\nstatus: ACTIVE"), undefined);
  assertEquals(parseServer("% IANA WHOIS server\n"), undefined);
});

// --- stage: injected query, no network ---

const IANA = (zone: string) => zone === "io" ? "whois:        whois.nic.io\n" : zone === "xx" ? "whois:\n" : "";

function stub(answer: (host: string, q: string) => string | Error) {
  const log: string[] = [];
  const query = (host: string, q: string) => {
    log.push(`${host}|${q}`);
    const r = host === "whois.iana.org" ? IANA(q) : answer(host, q);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { log, query };
}

Deno.test("whois43Stage: free, taken with state, unknown, error, via the server IANA names, asked once per zone", async () => {
  const { log, query } = stub((_h, q) =>
    q === "a.io"
      ? fixture("io.free")
      : q === "b.io"
      ? "Domain Name: b.io\nDomain Status: ok\n"
      : q === "c.io"
      ? "???"
      : new Error("timeout")
  );
  const out = await whois43Stage(["a.io", "b.io", "c.io", "d.io"], 2, query);
  assertEquals(out, ["FREE a.io", "taken-whois b.io (ok)", "UNKNOWN c.io", "ERR d.io"]);
  assertEquals(log.filter((l) => l.startsWith("whois.iana.org")), ["whois.iana.org|io"]);
});

Deno.test("whois43Stage: a rate-limit text is ERR; a refused IANA lookup is ERR", async () => {
  const limited = stub(() => "% Error: access control limit reached\n");
  assertEquals(await whois43Stage(["a.io"], 1, limited.query), ["ERR a.io"]);
  const down = (_h: string, _q: string) => Promise.reject(new Error("refused"));
  assertEquals(await whois43Stage(["a.io"], 1, down), ["ERR a.io"]);
});

Deno.test("whois43Stage: zone without a whois server is UNKNOWN with one stderr note per zone", async () => {
  const notes: string[] = [];
  const orig = console.error;
  console.error = (m: string) => notes.push(m);
  try {
    const { log, query } = stub(() => "unused");
    assertEquals(await whois43Stage(["a.xx", "b.xx", "a.yy"], 1, query), [
      "UNKNOWN a.xx",
      "UNKNOWN b.xx",
      "UNKNOWN a.yy",
    ]);
    assertEquals(log.filter((l) => !l.startsWith("whois.iana.org")), []);
  } finally {
    console.error = orig;
  }
  assertEquals(notes.length, 2);
  assertEquals(notes[0].includes(".xx"), true);
});

Deno.test("whois43Stage: a failed IANA lookup is not cached, the next name retries it", async () => {
  let iana = 0;
  const query = (host: string, q: string) =>
    host === "whois.iana.org"
      ? ++iana === 1 ? Promise.reject(new Error("timeout")) : Promise.resolve(IANA(q))
      : Promise.resolve(fixture("io.free"));
  assertEquals(await whois43Stage(["a.io", "b.io"], 1, query), ["ERR a.io", "FREE b.io"]);
});

Deno.test("whois43Stage: punycode is what is sent", async () => {
  const { log, query } = stub(() => fixture("io.free"));
  await whois43Stage(["тест.io"], 1, query);
  assertEquals(log[1], "whois.nic.io|xn--e1aybc.io");
});
