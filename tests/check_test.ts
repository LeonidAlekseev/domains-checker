import { assertEquals } from "@std/assert";
import { delegated, parseNames, parseWhois, sortLines } from "../src/check.ts";

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

Deno.test("delegated: NS answer means delegated, one attempt", async () => {
  let calls = 0;
  assertEquals(await delegated("a", () => (calls++, Promise.resolve())), true);
  assertEquals(calls, 1);
});

Deno.test("delegated: NotFound is final, no retry", async () => {
  let calls = 0;
  assertEquals(await delegated("a", () => (calls++, Promise.reject(new Deno.errors.NotFound()))), false);
  assertEquals(calls, 1);
});

Deno.test("delegated: timeout retried once, then not delegated", async () => {
  let calls = 0;
  const timeout = () => (calls++, Promise.reject(new DOMException("t", "TimeoutError")));
  assertEquals(await delegated("a", timeout), false);
  assertEquals(calls, 2);
});

Deno.test("delegated: second attempt can succeed", async () => {
  let calls = 0;
  const flaky = () => ++calls === 1 ? Promise.reject(new DOMException("t", "TimeoutError")) : Promise.resolve();
  assertEquals(await delegated("a", flaky), true);
});
