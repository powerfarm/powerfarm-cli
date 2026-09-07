import { createClient, whoAmI } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { userInfo } from "../lib/oauth.mjs";
import { facts, json, out, style } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm whoami")} — show the signed-in identity.

USAGE
  powerfarm whoami [--json]
`;

export async function run(argv) {
  const { flags } = parse(argv);
  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  const [profile, registry] = await Promise.all([
    userInfo({ issuerUrl: session.endpoints.issuerUrl, accessToken: session.accessToken }),
    whoAmI(client),
  ]);

  if (flags.json) {
    json({
      profile: session.profileName,
      subject: profile?.sub ?? null,
      email: profile?.email ?? null,
      identity: registry.identity,
      grants: registry.grants,
    });
    return 0;
  }

  facts([
    ["email", profile?.email ?? style.grey("—")],
    ["subject", style.grey(profile?.sub ?? "—")],
    ["identity", registry.identity
      ? `${registry.identity.name} ${style.grey(`(${registry.identity.kind})`)}`
      : style.yellow("not linked to a Powerfarm identity")],
    ["grants", registry.grants.length ? registry.grants.join(", ") : style.grey("none")],
    ["profile", session.profileName],
  ]);

  if (!registry.identity) {
    out();
    out(style.grey("  Without an identity link most commands will be refused by RLS."));
  }
  return 0;
}
