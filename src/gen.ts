/** Mask expansion: C consonant, V vowel, D digit, L letter, A any of a-z0-9-; [a-z0-9-] are literals. */

export interface Sets {
  cons: string[];
  vows: string[];
}

const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];
const DIGITS = [..."0123456789"];

export const VOWELS = "aeiouy"; // y is a vowel everywhere

/** Default letter sets: six vowels (y included), the other 20 letters as consonants. */
export function defaultSets(): Sets {
  const vows = [...VOWELS];
  return { cons: LETTERS.filter((l) => !vows.includes(l)), vows };
}

/** Parse a space-separated env list; fall back to `fallback` when unset or empty. */
export function parseList(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "").split(/\s+/).filter(Boolean);
  return items.length ? items : fallback;
}

function classes(mask: string, sets: Sets): string[][] {
  if (!/^[CVDLAa-z0-9-]+$/.test(mask)) {
    throw new Error(`invalid mask "${mask}": use C V D L A or literal a-z 0-9 -`);
  }
  const table: Record<string, string[]> = {
    C: sets.cons,
    V: sets.vows,
    D: DIGITS,
    L: LETTERS,
    A: [...LETTERS, ...DIGITS, "-"],
  };
  return [...mask].map((ch) => table[ch] ?? [ch]);
}

/** Number of combinations before the .ru filter. */
export function countNames(mask: string, sets: Sets): number {
  return classes(mask, sets).reduce((n, set) => n * set.length, 1);
}

const WARN_ABOVE = 1_000_000;

/** Warning text when the mask yields more than a million combinations, else undefined. */
export function warnTooMany(mask: string, sets: Sets): string | undefined {
  const total = countNames(mask, sets);
  return total > WARN_ABOVE ? `warning: mask ${mask} yields ${total} combinations` : undefined;
}

/** .ru rules: length 2–63, no leading/trailing hyphen, no `--` at positions 3–4. */
export function isValidName(name: string): boolean {
  return name.length >= 2 && name.length <= 63 && !name.startsWith("-") && !name.endsWith("-") &&
    name.slice(2, 4) !== "--";
}

/** Stream every valid name for the mask, one at a time (odometer over the class sets). */
export function* names(mask: string, sets: Sets): Generator<string> {
  const cls = classes(mask, sets);
  if (cls.some((set) => !set.length)) return;
  const idx = cls.map(() => 0);
  while (true) {
    const name = idx.map((i, k) => cls[k][i]).join("");
    if (isValidName(name)) yield name;
    let k = cls.length - 1;
    while (k >= 0 && ++idx[k] === cls[k].length) idx[k--] = 0;
    if (k < 0) return;
  }
}
