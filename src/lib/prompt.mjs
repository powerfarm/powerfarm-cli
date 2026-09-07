import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

/** Read a line. Works when piped, so `echo tok | powerfarm login --token` works. */
export function ask(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Read a secret without echoing it, falling back to a plain read when piped. */
export function askSecret(question) {
  if (!stdin.isTTY) return ask("");
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    // Swallow the echo of everything except the newline.
    const onKeypress = () => {
      const written = rl.line.length;
      stdout.write(`\u001b[2K\u001b[G${question}${"•".repeat(written)}`);
    };
    stdout.write(question);
    stdin.on("data", onKeypress);
    rl.question("", (answer) => {
      stdin.removeListener("data", onKeypress);
      stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(question, { assumeYes = false } = {}) {
  if (assumeYes || !stdin.isTTY) return assumeYes;
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}
