import { parse } from "../lib/args.mjs";
import { clearAllCredentials, clearCredential } from "../lib/credentials.mjs";
import { mark, out, style } from "../lib/output.mjs";
import { confirm } from "../lib/prompt.mjs";
import { loadContext } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm logout")} — discard stored credentials.

USAGE
  powerfarm logout [options]

OPTIONS
  --all            Remove every profile's credentials
  --yes            Do not ask for confirmation
  --profile <name> Log out of a named profile
`;

export async function run(argv) {
  const { flags } = parse(argv, {
    all: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
  });

  if (flags.all) {
    if (!await confirm("Remove credentials for every profile?", { assumeYes: flags.yes })) {
      out(`${mark.info()} Left untouched.`);
      return 0;
    }
    const removed = await clearAllCredentials();
    out(removed
      ? `${mark.ok()} All credentials removed.`
      : `${mark.info()} There were no stored credentials.`);
    return 0;
  }

  const { profileName } = await loadContext({ profile: flags.profile });
  const removed = await clearCredential(profileName);
  out(removed
    ? `${mark.ok()} Signed out of ${style.bold(profileName)}.`
    : `${mark.info()} Profile ${style.bold(profileName)} was not signed in.`);

  if (process.env.POWERFARM_TOKEN) {
    out(`  ${style.grey("POWERFARM_TOKEN is still set in this shell and will keep authenticating.")}`);
  }
  return 0;
}
