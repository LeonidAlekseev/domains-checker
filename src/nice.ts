/** `--nice` heuristic: keep only names that sound good. All rules live in this file; edit the lists below. */

export const VOWELS = "aeiouy"; // y is a vowel everywhere
export const BANNED = "qxwjcy"; // ambiguous to read
export const MAX_CONS_RUN = 2;
export const MAX_VOWEL_RUN = 2;
/** Two-consonant clusters allowed at the start of a part. */
export const ONSETS = "br tr dr gr kr pr fr bl pl kl gl fl sl st sp sk sm sn".split(" ");
/** Two-consonant clusters allowed inside or at the end of a part (onsets are allowed there too). */
export const INNER = [..."nd nk mb nt ld lt rd rt rk rm rn".split(" "), ...ONSETS];

/** Letter parts of a name; digits and `-` split it. */
function parts(name: string): string[] {
  return name.split(/[^a-z]+/).filter(Boolean);
}

function niceLetters(part: string): boolean {
  if ([...part].some((ch) => BANNED.includes(ch))) return false;
  if (!new RegExp(`[${VOWELS}]`).test(part)) return false;
  if (/(.)\1/.test(part)) return false;
  if (new RegExp(`[^${VOWELS}]{${MAX_CONS_RUN + 1}}`).test(part)) return false;
  if (new RegExp(`[${VOWELS}]{${MAX_VOWEL_RUN + 1}}`).test(part)) return false;
  for (const m of part.matchAll(new RegExp(`[^${VOWELS}]{2}`, "g"))) {
    if (!(m.index === 0 ? ONSETS : INNER).includes(m[0])) return false;
  }
  return true;
}

export function isNice(name: string): boolean {
  return parts(name).every(niceLetters);
}
