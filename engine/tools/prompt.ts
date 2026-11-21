// Questions only a person at a terminal can answer. Secret values and the
// confirmations that guard the restrict lock go through here, so a coding
// agent driving a shell without a terminal cannot answer them.
import { fail } from "./cli.ts";

/** Stop unless a person is at an interactive terminal. */
export function requireTerminal(action: string, why: string): void {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  fail(`${action} needs a person at a terminal: ${why}`, "Open a terminal in this folder and run the command yourself.");
}

/** Read one line without showing it. Resolves with the text; exits on Ctrl+C. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const finish = (result: string | undefined): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (result === undefined) fail("Cancelled. Nothing was changed.");
      resolve(result);
    };
    const onData = (chunk: string): void => {
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i]!;
        if (char === "\u0003" || char === "\u0004") return finish(undefined); // Ctrl+C, Ctrl+D
        if (char === "\r" || char === "\n") {
          // Text after the line break means a multi-line paste: refuse instead of saving half of it.
          if (chunk.slice(i + 1).replace(/[\r\n]/g, "") !== "") {
            input.setRawMode(false);
            process.stdout.write("\n");
            fail("That value has several lines. Only single-line values are supported.", "Paste it as one line (many providers accept \\n in place of line breaks).");
          }
          return finish(value);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

/** Ask the person to type an exact word. Anything else means no. */
export function confirmByTyping(question: string, word: string): Promise<boolean> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(`${question}\nType "${word}" and press Enter to continue (anything else cancels): `);
    input.resume();
    input.setEncoding("utf8");
    input.once("data", (chunk: string) => {
      input.pause();
      resolve(chunk.trim().toLowerCase() === word.toLowerCase());
    });
  });
}
