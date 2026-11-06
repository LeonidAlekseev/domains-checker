/**
 * The log on stderr: header, one live bar per stage, FREE as found, summary.
 * Live parts only on a terminal; anywhere else, plain messages. NO_COLOR turns colours off.
 */

export type Term = {
  /** stderr is a terminal. */
  live: boolean;
  color: boolean;
  columns: () => number;
  write: (text: string) => void;
};

export function realTerm(): Term {
  const encoder = new TextEncoder();
  return {
    live: Deno.stderr.isTerminal(),
    color: !Deno.noColor,
    columns: () => {
      try {
        return Deno.consoleSize().columns || 80;
      } catch {
        return 80;
      }
    },
    write: (text) => {
      let bytes = encoder.encode(text);
      while (bytes.length) bytes = bytes.subarray(Deno.stderr.writeSync(bytes));
    },
  };
}

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const BAR_WIDTH = 30;
const MIN_BAR = 5;
const ORDER = ["FREE", "taken", "UNKNOWN", "ERR"];

function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/** "FREE 3 · taken 2" for result lines, in a fixed order. */
function tally(counts: Map<string, number>) {
  return ORDER.filter((k) => counts.has(k)).map((k) => `${k} ${counts.get(k)}`).join(" · ");
}

function count(counts: Map<string, number>, line: string) {
  const kind = line.split(/[ -]/)[0];
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

type Stage = { name: string; total: number; done: number; start: number; counts: Map<string, number> };

export function createUi(t: Term) {
  const paint = (code: string) => (s: string) => t.live && t.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  const [bold, dim, red, green, yellow, cyan] = ["1", "2", "31", "32", "33", "36"].map(paint);
  const mark = (symbol: string, style: (s: string) => string) => t.live ? `${style(symbol)} ` : "";

  const started = performance.now();
  let stage: Stage | undefined;
  let tick = 0;
  let paused = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const clear = () => t.live && t.write("\r\x1b[2K");

  /** The bar is what shrinks; below that the line is cut, so a `\r` redraw never meets a wrapped line. */
  const barLine = (s: Stage) => {
    const elapsed = performance.now() - s.start;
    const eta = s.done ? duration(elapsed * (s.total - s.done) / s.done) : "…";
    const frame = FRAMES[tick % FRAMES.length];
    const stats = tally(s.counts);
    const right = ` ${s.done}/${s.total} ${Math.floor(s.done * 100 / s.total)}% ETA ${eta}${stats && ` · ${stats}`}`;
    const width = Math.max(t.columns() - 1, 1);
    const room = Math.min(width - s.name.length - 3 - right.length, BAR_WIDTH);
    if (room < MIN_BAR) return `${frame} ${s.name} ${right}`.slice(0, width);
    const full = Math.floor(room * s.done / s.total);
    return `${cyan(frame)} ${s.name} ${green("━".repeat(full))}${dim("─".repeat(room - full))}${right}`;
  };

  const draw = () => {
    if (t.live && stage && !paused) t.write(`\r\x1b[2K${barLine(stage)}`);
  };

  /** A finished line above the bar. */
  const above = (line: string) => {
    clear();
    t.write(`${line}\n`);
    draw();
  };

  const stop = () => {
    clearInterval(timer);
    if (stage && !paused) clear();
    stage = undefined;
  };

  return {
    stop,

    header: (title: string, detail: string) => t.live && t.write(`${bold(cyan(title))}  ${dim(detail)}\n`),

    warn: (message: string) => above(mark("⚠", yellow) + message),

    error: (message: string) => above(mark("✖", red) + message),

    stage: (name: string, total: number) => {
      stage = { name, total, done: 0, start: performance.now(), counts: new Map() };
      if (t.live) timer ??= setInterval(() => (tick++, draw()), 100);
      draw();
    },

    result: (line?: string) => {
      if (!stage) return;
      stage.done++;
      if (line) count(stage.counts, line);
      if (t.live && line?.startsWith("FREE ")) above(`${bold(green("★"))} ${bold(green(line.slice(5)))}`);
      if (stage.done < stage.total) return draw();
      const { name, total, counts, start } = stage;
      stage = undefined;
      clear();
      const stats = [total, tally(counts)].filter(Boolean).join(" · ");
      if (t.live) t.write(`${green("✔")} ${name}  ${stats}  ${dim(duration(performance.now() - start))}\n`);
    },

    /** The bar is off while `fn` holds the terminal (the captcha prompt), and back after it. */
    pause: async <T>(fn: () => Promise<T>): Promise<T> => {
      clear();
      paused = true;
      try {
        return await fn();
      } finally {
        paused = false;
        draw();
      }
    },

    /** Elapsed time, counts per status, the FREE file. Off a terminal it is printed only for an interrupted run. */
    summary: (lines: string[], notChecked: number, file: string | undefined, interrupted: boolean) => {
      if (!t.live && !interrupted) return;
      const counts = new Map<string, number>();
      for (const line of lines) count(counts, line);
      const parts = [tally(counts), notChecked ? `${notChecked} not checked` : ""].filter(Boolean).join(" · ");
      const time = duration(performance.now() - started);
      const title = interrupted
        ? `${mark("⚠", yellow)}interrupted after ${time}`
        : `${mark("✔", green)}done in ${time}`;
      const saved = file ? `\n${t.live ? "  " : ""}FREE saved to ${file}` : "";
      t.write(`${bold(title)}${parts && `  ${parts}`}${saved}\n`);
    },
  };
}
