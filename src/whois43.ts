/** Port 43 whois: find the registry server through IANA, query it, classify the text. */

export type Query = (host: string, query: string) => Promise<string>;

const MAX_CHARS = 64 * 1024;

/** One query, abandoned after `ms` whatever happens (Deno.connect has no timeout of its own). */
export async function whoisQuery(host: string, query: string, ms = 10_000): Promise<string> {
  let conn: Deno.Conn | undefined;
  let late = false; // the deadline passed while still connecting: close the socket when it finally opens
  let expire!: () => void;
  const expired = new Promise<never>((_, rej) => expire = () => rej(new Error("timeout")));
  expired.catch(() => {});
  const timer = setTimeout(() => (late = true, conn?.close(), expire()), ms);
  try {
    const connecting = Deno.connect({ hostname: host, port: 43 });
    connecting.then((c) => late && c.close(), () => {});
    conn = await Promise.race([connecting, expired]);
    await conn.write(new TextEncoder().encode(query + "\r\n"));
    const dec = new TextDecoder();
    const buf = new Uint8Array(4096);
    let text = "";
    for (let n; text.length < MAX_CHARS && (n = await conn.read(buf)) !== null;) {
      text += dec.decode(buf.subarray(0, n), { stream: true });
    }
    return text;
  } catch (e) {
    throw late || e instanceof Deno.errors.BadResource ? new Error("timeout") : e;
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch { /* already closed */ }
  }
}

export type Whois43 = { kind: "free" } | { kind: "taken"; state?: string } | { kind: "limited" } | { kind: "unknown" };

/**
 * The one table to edit when a registry words things differently. Every pattern is a line start
 * (after an optional `%`/`#`), so terms-of-use prose that mentions "limit" or "not found" never matches.
 * FREE needs a positive match here; a text that matches nothing is "unknown".
 */
export const PATTERNS = {
  free: [
    /^[%#\s]*(domain not found|no data found|no match|not found|no entries found|nothing found)/im, // general
    /^the queried object does not exist: domain not found/im, // .co .la
    /^domain "[^"]*" not found/im, // .se
    /^status:\s*(free|available)\s*$/im, // .de .it .be .eu
  ],
  limited: [
    /^[%#\s]*(\S+\s+){0,3}limit\b.*\b(exceeded|reached)/im, // "access control limit reached", "query limit exceeded"
    /^[%#\s]*(error\b.*\b(too many|refused)|too many (requests|queries|connections))/im,
    /^requests of this client are not permitted/im, // .ch
  ],
  taken: [/^domain(?: name)?:[ \t]*\S/im],
};

const STATE = /^(?:domain )?(?:status|state):[ \t]*(.+)$/im;

/** Classify a registry answer; a free verdict only comes from a positive pattern. */
export function parseWhois43(text: string): Whois43 {
  if (PATTERNS.limited.some((re) => re.test(text))) return { kind: "limited" };
  if (PATTERNS.free.some((re) => re.test(text))) return { kind: "free" };
  if (!PATTERNS.taken.some((re) => re.test(text))) return { kind: "unknown" };
  // untrusted text: one line, no control characters, cut to a sane length
  const state = text.match(STATE)?.[1].split(/\s+https?:/)[0].replace(/\p{C}/gu, "").trim().slice(0, 80);
  return state ? { kind: "taken", state } : { kind: "taken" };
}

/** The `whois:` line of an IANA answer for a zone. */
export const parseServer = (text: string) => text.match(/^whois:[ \t]*(\S+)/im)?.[1];
