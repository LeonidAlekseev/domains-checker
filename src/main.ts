#!/usr/bin/env -S deno run --allow-net --allow-env=CONS,VOWS,WHOIS_P --allow-read=/dev/tty,CONIN$
/**
 * domains-checker — mass check of free domains in any zone.
 *
 *   domains-checker gen CVCV | domains-checker check > result.txt
 */

import { parseArgs } from "@std/cli/parse-args";
import denoJson from "../deno.json" with { type: "json" };
import { check, maskProxy, parseNames, parseZones, sortLines, toDomains } from "./check.ts";
import { defaultSets, names, parseList, warnTooMany } from "./gen.ts";
import { isNice } from "./nice.ts";
import { ttyPrompt } from "./prompt.ts";

const HELP = `domains-checker ${denoJson.version} — mass check of free domains in any zone.

Usage:
  domains-checker gen MASK [--nice]
                               print every name matching the mask, one per line;
                               --nice keeps only pronounceable names
  domains-checker check [--tld ru,com,...] [--proxy URL]...
                               read names from stdin (a name without a dot is checked in every --tld zone,
                               default ru; a name with a dot as is), print one line per domain:
                               FREE / taken-delegated / taken-whois / taken-rdap / UNKNOWN / ERR;
                               on a whois.ru captcha: next --proxy, else ask on the terminal, else stop

Mask: C consonant, V vowel, D digit, L letter, A any of a-z 0-9 -; lowercase letters, digits and - are literals.
Env:  CONS, VOWS (space-separated letters for C and V; default vowels a e i o u y), WHOIS_P (whois parallelism, default 2).
Example: domains-checker gen CVCV | domains-checker check --tld ru,com > result.txt

FREE means unregistered: premium or reserved names may still be unavailable. UNKNOWN: not checked, because the zone has
no whois.ru, RDAP or port 43 whois server, the registry answer was not understood, or the name has more than one dot
(only name.zone and name.<--tld zone> are checked). Cyrillic names and zones are accepted.

  --tld LIST      comma-separated zones for names without a dot (default ru)
  --proxy URL     proxy for whois.ru only (http, https, socks5, socks5h); repeatable, used one per captcha
  -V, --version   print version
  -h, --help      show this help`;

function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

async function gen(mask: string | undefined, nice: boolean) {
  if (!mask) fail("usage: domains-checker gen MASK (e.g. CVCV)");
  const defaults = defaultSets();
  const sets = {
    cons: parseList(Deno.env.get("CONS"), defaults.cons),
    vows: parseList(Deno.env.get("VOWS"), defaults.vows),
  };
  try {
    const warning = warnTooMany(mask, sets);
    if (warning) console.error(warning);
    // Deno.stdout.write may write partially; the stream writer writes everything.
    const out = Deno.stdout.writable.getWriter();
    const enc = new TextEncoder();
    let buf: string[] = [];
    for (const name of names(mask, sets)) {
      if (nice && !isNice(name)) continue;
      if (buf.push(name + "\n") >= 10_000) await out.write(enc.encode(buf.join(""))), buf = [];
    }
    await out.write(enc.encode(buf.join("")));
    out.releaseLock();
  } catch (e) {
    fail((e as Error).message);
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "nice"],
    collect: ["proxy"],
    string: ["proxy", "tld"],
    alias: { h: "help", V: "version" },
    unknown: (arg) => !arg.startsWith("-") || fail(`Unknown option ${arg}, see --help`),
  });
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(denoJson.version);
  const [cmd, ...rest] = args._.map(String);
  if (cmd === "gen" && rest.length <= 1) return await gen(rest[0], args.nice);
  if (cmd === "check" && !rest.length && !args.nice) {
    const proxies = args.proxy as string[];
    for (const p of proxies) {
      if (!/^(https?|socks5h?):\/\/./.test(p)) {
        fail(`--proxy ${maskProxy(p)}: use http://, https://, socks5:// or socks5h://`);
      }
    }
    const zones = parseZones(args.tld ?? "ru");
    if (!zones) fail(`--tld ${args.tld}: zones are comma-separated, like ru,com or co.uk`);
    const whoisParallel = Number(Deno.env.get("WHOIS_P") || 2);
    if (!(whoisParallel >= 1)) fail("WHOIS_P must be a positive number");
    const input = await new Response(Deno.stdin.readable).text();
    const { domains, unknown } = toDomains(parseNames(input), zones);
    if (unknown.length) {
      console.error(
        `${unknown.length} name(s) with more than one dot are UNKNOWN (not checked), e.g. ${unknown[0]}; ` +
          "only name.zone or name.<--tld zone> are checked",
      );
    }
    try {
      const lines = await check(domains, Math.floor(whoisParallel), { proxies, prompt: ttyPrompt });
      for (const line of sortLines([...lines, ...unknown.map((d) => `UNKNOWN ${d}`)])) console.log(line);
    } catch (e) {
      fail((e as Error).message);
    }
    return;
  }
  fail(HELP);
}

if (import.meta.main) await main();
