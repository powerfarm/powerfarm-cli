import { parse } from "../lib/args.mjs";
import { resolveEndpoints } from "../lib/config.mjs";
import { readConfig, readCredentials, writeConfig } from "../lib/credentials.mjs";
import { CliError } from "../lib/errors.mjs";
import { json, mark, out, style, table } from "../lib/output.mjs";

export const help = `
${style.bold("powerfarm profile")} — manage named profiles.

USAGE
  powerfarm profile list
  powerfarm profile use <name>
  powerfarm profile set <name> --api-url <url> [--registry-url <url>]
                                [--identity-url <url>] [--client-id <id>]
  powerfarm profile remove <name>

A profile pins a set of endpoints. Anything it does not pin falls back to the
environment, then to the production defaults — so a staging profile needs only
the URLs that actually differ.
`;

export async function run(argv) {
  const { flags, args } = parse(argv, {
    "api-url": { type: "string" },
    "registry-url": { type: "string" },
    "identity-url": { type: "string" },
    "client-id": { type: "string" },
    "publishable-key": { type: "string" },
  });
  const [action = "list", name] = args;

  const config = await readConfig();
  config.profiles ??= {};

  if (action === "list") {
    const credentials = await readCredentials();
    const names = new Set([
      ...Object.keys(config.profiles),
      ...Object.keys(credentials.profiles ?? {}),
      config.defaultProfile ?? "default",
    ]);
    const rows = [...names].map((entry) => {
      const endpoints = resolveEndpoints(config.profiles[entry]);
      return {
        name: entry === config.defaultProfile ? `${entry} ${style.grey("(default)")}` : entry,
        api: endpoints.apiUrl,
        signedIn: credentials.profiles?.[entry] ? mark.ok() : style.grey("—"),
      };
    });
    if (flags.json) return json(rows), 0;
    table(rows, [["name", "PROFILE"], ["api", "API"], ["signedIn", "AUTH"]]);
    return 0;
  }

  if (action === "use") {
    if (!name) throw new CliError("Name the profile to use.");
    config.defaultProfile = name;
    await writeConfig(config);
    out(`${mark.ok()} Default profile is now ${style.bold(name)}.`);
    return 0;
  }

  if (action === "set") {
    if (!name) throw new CliError("Name the profile to configure.");
    const mapping = {
      "api-url": "apiUrl",
      "registry-url": "registryUrl",
      "identity-url": "identityUrl",
      "client-id": "clientId",
      "publishable-key": "publishableKey",
    };
    const changes = {};
    for (const [flag, key] of Object.entries(mapping)) {
      if (flags[flag]) changes[key] = flags[flag];
    }
    if (Object.keys(changes).length === 0) {
      throw new CliError("Nothing to set.", { hint: "Pass at least one of --api-url, --registry-url, --identity-url, --client-id." });
    }
    config.profiles[name] = { ...config.profiles[name], ...changes };
    await writeConfig(config);
    out(`${mark.ok()} Updated profile ${style.bold(name)}.`);
    for (const [key, value] of Object.entries(changes)) out(`  ${style.grey(key)} ${value}`);
    return 0;
  }

  if (action === "remove") {
    if (!name) throw new CliError("Name the profile to remove.");
    if (!config.profiles[name]) throw new CliError(`No profile named ${style.bold(name)}.`);
    delete config.profiles[name];
    if (config.defaultProfile === name) config.defaultProfile = "default";
    await writeConfig(config);
    out(`${mark.ok()} Removed profile ${style.bold(name)}.`);
    out(`  ${style.grey("Its stored credential is untouched; run `powerfarm logout --profile " + name + "` to clear it.")}`);
    return 0;
  }

  throw new CliError(`Unknown subcommand \`${action}\`.`, {
    hint: "Try `list`, `use`, `set` or `remove`.",
  });
}
