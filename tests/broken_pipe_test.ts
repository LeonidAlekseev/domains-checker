import { assertEquals } from "@std/assert";

// Runs the CLI as a real process, closes its stdout after the first chunk (like `| head`),
// and checks that it exits 0 without writing anything to stderr.
Deno.test("gen exits quietly with 0 when stdout is closed early", async () => {
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-env=CONS,VOWS,WHOIS_P", `${import.meta.dirname}/../src/main.ts`, "gen", "LLLL"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  await reader.read();
  await reader.cancel();
  const { code } = await child.status;
  assertEquals(await stderr, "");
  assertEquals(code, 0);
});
