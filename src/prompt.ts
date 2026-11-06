import type { CaptchaChoice } from "./check.ts";

/** Ask on the controlling terminal (stdin is a pipe in `gen | check`). No terminal: "no-terminal". */
export async function ttyPrompt(link: string, say: (message: string) => void = console.error): Promise<CaptchaChoice> {
  let tty: Deno.FsFile;
  try {
    tty = await Deno.open(Deno.build.os === "windows" ? "CONIN$" : "/dev/tty", { read: true });
  } catch {
    return "no-terminal";
  }
  try {
    say(`captcha: open ${link} in a browser and pass it.`);
    while (true) {
      say("Press Enter to continue, q + Enter to stop: ");
      const buf = new Uint8Array(256);
      const n = await tty.read(buf);
      if (n === null) return "stop"; // EOF
      const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
      if (answer === "") return "continue";
      if (answer === "q") return "stop";
    }
  } finally {
    tty.close();
  }
}
