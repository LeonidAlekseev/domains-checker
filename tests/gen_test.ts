import { assertEquals, assertThrows } from "@std/assert";
import { countNames, isValidName, names } from "../src/gen.ts";

const sets = { cons: ["b", "c"], vows: ["a", "e"] };
const list = (mask: string) => [...names(mask, sets)];

Deno.test("C and V classes use the given sets", () => {
  assertEquals(list("CV"), ["ba", "be", "ca", "ce"]);
});

Deno.test("D, L, A classes", () => {
  assertEquals(list("D").length, 0); // length 1 is dropped by the .ru filter
  assertEquals(list("aD").length, 10);
  assertEquals(list("LL").length, 676);
  assertEquals(countNames("AA", sets), 37 * 37);
});

Deno.test("literals: lowercase, digits, hyphen", () => {
  assertEquals(list("xC1"), ["xb1", "xc1"]);
  assertEquals(list("aV-b"), ["aa-b", "ae-b"]);
});

Deno.test("invalid mask characters are a usage error", () => {
  assertThrows(() => list("CvX"), Error, "mask");
  assertThrows(() => list("C_"), Error, "mask");
  assertThrows(() => list(""), Error, "mask");
});

Deno.test(".ru filter", () => {
  assertEquals(isValidName("a"), false);
  assertEquals(isValidName("ab"), true);
  assertEquals(isValidName("-ab"), false);
  assertEquals(isValidName("ab-"), false);
  assertEquals(isValidName("ab--c"), false);
  assertEquals(isValidName("abc--d"), true);
  assertEquals(isValidName("a".repeat(63)), true);
  assertEquals(isValidName("a".repeat(64)), false);
  assertEquals(list("-C"), []);
  assertEquals(list("aa-").length, 0);
});

Deno.test("count is the product of class sizes", () => {
  assertEquals(countNames("CVCV", sets), 16);
  assertEquals(countNames("CCCCCCCC", { cons: Array(21).fill("x"), vows: [] }), 21 ** 8);
});
