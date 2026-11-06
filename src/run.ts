/** One `check` run: live log and FREE file while it goes, result lines and summary at the end. */

import denoJson from "../deno.json" with { type: "json" };
import { check, sortLines, type WhoisOpts, zoneOf } from "./check.ts";
import { createUi, type Term } from "./ui.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Default FREE file: free-YYYYMMDD-HHMMSS.txt, local time. */
export function defaultOut(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
  return `free-${local.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.txt`;
}

/** Appends lines, each on disk before it returns; the file appears with the first line. */
function appender(path: string) {
  const encoder = new TextEncoder();
  let file: Deno.FsFile | undefined;
  return (line: string) => {
    file ??= Deno.openSync(path, { append: true, create: true });
    let bytes = encoder.encode(`${line}\n`);
    while (bytes.length) bytes = bytes.subarray(file.writeSync(bytes));
    file.syncSync();
  };
}

export type RunOpts = WhoisOpts & {
  /** FREE file. */
  out: string;
  term: Term;
  /** Result lines; async, so a stalled stdout leaves the event loop free for a second Ctrl+C. */
  print: (lines: string[]) => Promise<void>;
  stdoutTty: boolean;
};

export type Input = { names: number; domains: string[]; unknown: string[] };

/** Returns the exit code: 0, 1 on failure, 130 if `o.signal` stopped the run. */
export async function run({ names, domains, unknown }: Input, parallel: number, o: RunOpts): Promise<number> {
  const ui = createUi(o.term);
  ui.header(
    `domains-checker ${denoJson.version}`,
    [
      plural(names, "name"),
      plural(new Set(domains.map(zoneOf)).size, "zone"),
      plural(domains.length, "domain"),
    ].join(" · "),
  );
  if (unknown.length) {
    ui.warn(
      `${unknown.length} name(s) with more than one dot are UNKNOWN (not checked), e.g. ${unknown[0]}; ` +
        "only name.zone or name.<--tld zone> are checked",
    );
  }
  const save = appender(o.out);
  let saved = false;
  const onResult = (line?: string) => {
    if (line?.startsWith("FREE ")) {
      try {
        save(line.slice(5));
        saved = true;
      } catch (e) {
        ui.warn(`cannot save ${line.slice(5)} to ${o.out}: ${(e as Error).message}`); // stdout still gets it
      }
    }
    ui.result(line);
  };
  const prompt = o.prompt;
  try {
    const lines = await check(domains, parallel, {
      ...o,
      onResult,
      onStage: ui.stage,
      warn: ui.warn,
      prompt: prompt && ((link, say) => ui.pause(() => prompt(link, say))),
    });
    ui.stop();
    const all = sortLines([...lines, ...unknown.map((d) => `UNKNOWN ${d}`)]);
    const shownLive = o.stdoutTty && o.term.live;
    await o.print(all.filter((line) => !(shownLive && line.startsWith("FREE "))));
    const interrupted = !!o.signal?.aborted;
    ui.summary(all, domains.length - lines.length, saved ? o.out : undefined, interrupted);
    return interrupted ? 130 : 0;
  } catch (e) {
    ui.stop();
    ui.error((e as Error).message);
    return 1;
  }
}
