#!/usr/bin/env -S deno run --allow-net=1.1.1.1,whois.ru --allow-env=CONS,VOWS,WHOIS_P
/**
 * domains-checker — mass check of free .ru domains.
 *
 *   domains-checker gen CVCV | domains-checker check > result.txt
 */

import { parseArgs } from "@std/cli/parse-args";
import denoJson from "../deno.json" with { type: "json" };
import { check, parseNames } from "./check.ts";
import { defaultSets, names, parseList, warnTooMany } from "./gen.ts";
import { isNice } from "./nice.ts";

const HELP = `domains-checker ${denoJson.version} — mass check of free .ru domains.

Usage:
  domains-checker gen MASK [--nice]
                               print every name matching the mask, one per line;
                               --nice keeps only pronounceable names
  domains-checker check        read names from stdin, print FREE / taken-delegated / taken-whois / ERR

Mask: C consonant, V vowel, D digit, L letter, A any of a-z 0-9 -; lowercase letters, digits and - are literals.
Env:  CONS, VOWS (space-separated letters for C and V; default vowels a e i o u y), WHOIS_P (whois parallelism, default 2).
Example: domains-checker gen CVCV | domains-checker check > result.txt

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
    alias: { h: "help", V: "version" },
    unknown: (arg) => !arg.startsWith("-") || fail(`Unknown option ${arg}, see --help`),
  });
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(denoJson.version);
  const [cmd, ...rest] = args._.map(String);
  if (cmd === "gen" && rest.length <= 1) return await gen(rest[0], args.nice);
  if (cmd === "check" && !rest.length && !args.nice) {
    const whoisParallel = Number(Deno.env.get("WHOIS_P") || 2);
    if (!(whoisParallel >= 1)) fail("WHOIS_P must be a positive number");
    const input = await new Response(Deno.stdin.readable).text();
    for (const line of await check(parseNames(input), Math.floor(whoisParallel))) console.log(line);
    return;
  }
  fail(HELP);
}

if (import.meta.main) await main();
