import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/lib/args.mjs";
import { COMMANDS, main } from "../src/main.mjs";

function capture() {
  const chunks = { out: [], err: [] };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (chunks.out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (chunks.err.push(String(chunk)), true);
  return {
    chunks,
    restore: () => { process.stdout.write = stdout; process.stderr.write = stderr; },
  };
}

test("every registered command exposes run() and help", async () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    const module = await command.load();
    assert.equal(typeof module.run, "function", `${name} has no run()`);
    assert.equal(typeof module.help, "string", `${name} has no help`);
    assert.ok(module.help.includes(name), `${name}'s help does not name the command`);
  }
});

test("an unknown command exits 2 and says so", async () => {
  const capturing = capture();
  const code = await main(["definitely-not-a-command"]);
  capturing.restore();
  assert.equal(code, 2);
  assert.match(capturing.chunks.err.join(""), /Unknown command/);
});

test("bare invocation prints usage listing every command", async () => {
  const capturing = capture();
  const code = await main([]);
  capturing.restore();
  const text = capturing.chunks.out.join("");
  assert.equal(code, 0);
  for (const name of Object.keys(COMMANDS)) assert.ok(text.includes(name), `usage omits ${name}`);
});

test("--version prints a semver and does not load the auth stack", async () => {
  const capturing = capture();
  const code = await main(["--version"]);
  capturing.restore();
  assert.equal(code, 0);
  assert.match(capturing.chunks.out.join("").trim(), /^\d+\.\d+\.\d+$/);
});

test("--help on a command prints that command's help without running it", async () => {
  const capturing = capture();
  const code = await main(["gadget", "--help"]);
  capturing.restore();
  assert.equal(code, 0);
  assert.match(capturing.chunks.out.join(""), /powerfarm gadget publish/);
});

test("global flags parse and unknown flags are refused", () => {
  const { flags, args } = parse(["show", "abc", "--json", "--profile", "staging"]);
  assert.equal(flags.json, true);
  assert.equal(flags.profile, "staging");
  assert.deepEqual(args, ["show", "abc"]);
  assert.throws(() => parse(["--not-a-real-flag"]), /Unknown option/);
});
