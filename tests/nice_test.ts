import { assertEquals } from "@std/assert";
import { defaultSets } from "../src/gen.ts";
import { isNice } from "../src/nice.ts";

const ok = (s: string) => assertEquals(isNice(s), true, s);
const bad = (s: string) => assertEquals(isNice(s), false, s);

Deno.test("default sets: y is a vowel", () => {
  const { cons, vows } = defaultSets();
  assertEquals(vows, ["a", "e", "i", "o", "u", "y"]);
  assertEquals(cons.join(""), "bcdfghjklmnpqrstvwxz");
  assertEquals(cons.length, 20);
});

Deno.test("examples kept", () => ["tavor", "belan", "mirko", "starn"].forEach(ok));

Deno.test("banned letters", () => ["qixel", "taxo", "wada", "jani", "cato", "tyra"].forEach(bad));
Deno.test("no 3 consonants or 3 vowels in a row", () => ["tvbal", "baeo", "taiu"].forEach(bad));
Deno.test("no doubled letter", () => ["baal", "bell"].forEach(bad));
Deno.test("start clusters", () => {
  ["rtova", "ndova", "mbola"].forEach(bad);
  ["brava", "stola"].forEach(ok);
});
Deno.test("inner clusters", () => {
  ["mirko", "balta"].forEach(ok);
  ["bafda", "mozbi"].forEach(bad);
});
Deno.test("every part needs a vowel; digits and hyphen split parts", () => {
  bad("bdr");
  ok("tavor1");
  ok("tavor-belan");
  bad("tavor-bdr");
  bad("1b"); // part "b" has no vowel
  ok("12"); // no letter parts: nothing to judge
});
