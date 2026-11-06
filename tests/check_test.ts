import { assertEquals } from "@std/assert";
import { parseNames, parseWhois, sortLines } from "../src/check.ts";

Deno.test("parseNames: separators, lowercase, filter, dedupe", () => {
  assertEquals(parseNames("Teef zvom,teef\nA-1\r\nbad.name x_y ü\n"), ["teef", "zvom", "a-1"]);
  assertEquals(parseNames(""), []);
});

Deno.test("parseWhois: free", () => {
  assertEquals(parseWhois("<p>Домен <b>свободен</b></p>"), { kind: "free" });
});

Deno.test("parseWhois: taken uses first state line", () => {
  const html = "<pre>domain: X.RU\nstate:  REGISTERED, DELEGATED, VERIFIED\nstate: other</pre>";
  assertEquals(parseWhois(html), { kind: "taken", state: "REGISTERED, DELEGATED, VERIFIED" });
});

Deno.test("parseWhois: captcha and unknown", () => {
  assertEquals(parseWhois("<p>Мы защиту от роботов включили</p>"), { kind: "captcha" });
  assertEquals(parseWhois("<html>oops</html>"), { kind: "unknown" });
});

Deno.test("sortLines is byte order", () => {
  assertEquals(sortLines(["taken-whois b", "FREE z", "ERR a", "FREE a"]), [
    "ERR a",
    "FREE a",
    "FREE z",
    "taken-whois b",
  ]);
});
