import { CliError } from "./lib/errors.mjs";
import { err, out, style } from "./lib/output.mjs";
import { VERSION } from "./lib/version.mjs";

/**
 * The command table. `load` is lazy so that `powerfarm --version` never pays
 * for the OAuth stack, and a broken command cannot stop the rest from running.
 */
export const COMMANDS = {
  login: { summary: "Authenticate this machine", load: () => import("./commands/login.mjs") },
  logout: { summary: "Discard stored credentials", load: () => import("./commands/logout.mjs") },
  whoami: { summary: "Show the signed-in identity", load: () => import("./commands/whoami.mjs") },
  status: { summary: "Show session, endpoints and grants", load: () => import("./commands/status.mjs") },
  doctor: { summary: "Diagnose a broken setup", load: () => import("./commands/doctor.mjs") },
  profile: { summary: "Manage named profiles", load: () => import("./commands/profile.mjs") },
  gadget: { summary: "Author, publish and install Gadgets", load: () => import("./commands/gadget.mjs") },
  oauth: { summary: "Manage OAuth clients", load: () => import("./commands/oauth.mjs") },
  runs: { summary: "Inspect runs", load: () => import("./commands/runs.mjs") },
  workspace: { summary: "Inspect workspaces", load: () => import("./commands/workspace.mjs") },
};

const ALIASES = {
  "-v": "version",
  "--version": "version",
  "-h": "help",
  "--help": "help",
  auth: "login",
  ls: "workspace",
  run: "runs",
};

export async function main(argv) {
  const [rawName, ...rest] = argv;
  const name = ALIASES[rawName] ?? rawName;

  if (!name || name === "help") return usage(rest[0]);
  if (name === "version") {
    out(VERSION);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    err(`${style.red("Unknown command")} ${style.bold(rawName)}`);
    err(`Run ${style.cyan("powerfarm help")} to see what is available.`);
    return 2;
  }

  try {
    const module = await command.load();
    if (rest.includes("--help") || rest.includes("-h")) {
      out(module.help.trim());
      return 0;
    }
    return (await module.run(rest)) ?? 0;
  } catch (error) {
    if (error instanceof CliError) {
      err(`${style.red("✗")} ${error.message}`);
      if (error.hint) err(`  ${style.grey(error.hint)}`);
      return error.code ?? 1;
    }
    if (error?.cause?.code === "ENOTFOUND" || error?.code === "ENOTFOUND") {
      err(`${style.red("✗")} Could not reach the network.`);
      err(`  ${style.grey("Check your connection, then run `powerfarm doctor`.")}`);
      return 3;
    }
    throw error;
  }
}

function usage(topic) {
  if (topic && COMMANDS[topic]) {
    return COMMANDS[topic].load().then((module) => {
      out(module.help.trim());
      return 0;
    });
  }

  const width = Math.max(...Object.keys(COMMANDS).map((key) => key.length));
  out(`${style.bold("powerfarm")} ${style.grey(VERSION)} — the Powerfarm command line.

${style.grey("USAGE")}
  powerfarm <command> [options]

${style.grey("COMMANDS")}`);
  for (const [name, { summary }] of Object.entries(COMMANDS)) {
    out(`  ${style.cyan(name.padEnd(width))}  ${summary}`);
  }
  out(`
${style.grey("GLOBAL OPTIONS")}
  --profile <name>   Use a named profile instead of the default
  --json             Emit machine-readable JSON
  -q, --quiet        Suppress non-essential output
  -h, --help         Show help for a command

${style.grey("ENVIRONMENT")}
  POWERFARM_TOKEN    Refresh token for CI; bypasses the credential store
  POWERFARM_PROFILE  Default profile name
  POWERFARM_API_URL  Override the Supabase project URL

Start with ${style.cyan("powerfarm login")}, then ${style.cyan("powerfarm status")}.`);
  return 0;
}
