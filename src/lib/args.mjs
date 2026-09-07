import { parseArgs } from "node:util";
import { CliError } from "./errors.mjs";

/** Flags every command understands. */
const GLOBAL = {
  json: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  quiet: { type: "boolean", short: "q", default: false },
};

/**
 * Parse a command's argv against its own options plus the global ones.
 * Unknown flags fail loudly rather than being silently swallowed.
 */
export function parse(argv, options = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { ...GLOBAL, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { flags: values, args: positionals };
  } catch (error) {
    throw new CliError(error.message, { hint: "Run with --help to see the accepted flags." });
  }
}
