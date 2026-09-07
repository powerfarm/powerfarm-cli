import { createClient, whoAmI } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { getCredential } from "../lib/credentials.mjs";
import { userInfo } from "../lib/oauth.mjs";
import { facts, json, mark, out, relativeTime, style } from "../lib/output.mjs";
import { loadContext, resolveSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm status")} — session, endpoints and authority at a glance.

USAGE
  powerfarm status [--json]

Reports which profile is active, where the token came from, when it expires,
which endpoints are in play and where each one was configured, and which
grants your identity holds. Use ${style.cyan("powerfarm doctor")} when something
here looks wrong and you need to know why.
`;

/** Where a value came from, so a surprising endpoint is traceable. */
function origin(key, envName, profile) {
  if (profile?.[key]) return "profile";
  if (process.env[envName]) return "env";
  return "default";
}

export async function run(argv) {
  const { flags } = parse(argv);
  const context = await loadContext({ profile: flags.profile });
  const { endpoints, profileName, config } = context;
  const profileConfig = config.profiles?.[profileName];

  const stored = await getCredential(profileName);
  let session = null;
  let identity = null;
  let registry = null;
  let failure = null;

  try {
    session = await resolveSession(context);
    if (session) {
      const client = createClient({ endpoints, accessToken: session.accessToken });
      [identity, registry] = await Promise.all([
        userInfo({ issuerUrl: endpoints.issuerUrl, accessToken: session.accessToken }),
        whoAmI(client).catch(() => null),
      ]);
    }
  } catch (error) {
    failure = error.message;
  }

  if (flags.json) {
    json({
      profile: profileName,
      authenticated: Boolean(session),
      source: session?.source ?? null,
      expiresAt: session?.credential?.expiresAt ?? null,
      hasRefreshToken: Boolean(session?.credential?.refreshToken),
      subject: identity?.sub ?? null,
      email: identity?.email ?? null,
      identity: registry?.identity ?? null,
      grants: registry?.grants ?? [],
      workspaces: registry?.workspaces ?? [],
      endpoints,
      error: failure,
    });
    return session ? 0 : 4;
  }

  const sourceLabel = {
    env: `${style.yellow("POWERFARM_TOKEN")} ${style.grey("(environment)")}`,
    token: `pasted token`,
    browser: `browser sign-in`,
  };

  out(style.grey("SESSION"));
  facts([
    ["profile", `${style.bold(profileName)}${
      config.defaultProfile === profileName ? style.grey("  (default)") : ""}`],
    ["signed in", session
      ? `${mark.ok()} ${sourceLabel[session.source] ?? session.source}`
      : `${mark.fail()} ${style.red("no")}`],
    ["identity", identity?.email ?? identity?.sub ?? style.grey("—")],
    ["expires", session?.credential?.expiresAt
      ? relativeTime(session.credential.expiresAt)
      : style.grey("—")],
    ["refresh", session?.credential?.refreshToken
      ? `${mark.ok()} held`
      : style.yellow("none — you will have to sign in again")],
  ]);

  if (failure) {
    out();
    out(`${mark.fail()} ${style.red(failure)}`);
  }

  out();
  out(style.grey("AUTHORITY"));
  facts([
    ["link", registry?.identity
      ? `${registry.identity.name} ${style.grey(`(${registry.identity.kind})`)}`
      : style.yellow("none")],
    ["grants", registry?.grants?.length
      ? registry.grants.join(", ")
      : style.grey("none")],
    ["workspace", registry?.workspaces?.[0]
      ? `${registry.workspaces[0].title} ${style.grey(registry.workspaces[0].slug)}`
      : style.grey("—")],
  ]);

  out();
  out(style.grey("ENDPOINTS"));
  facts([
    ["api", `${endpoints.apiUrl} ${style.grey(origin("apiUrl", "POWERFARM_API_URL", profileConfig))}`],
    ["registry", `${endpoints.registryUrl} ${style.grey(origin("registryUrl", "POWERFARM_REGISTRY_URL", profileConfig))}`],
    ["identity", `${endpoints.identityUrl} ${style.grey(origin("identityUrl", "POWERFARM_IDENTITY_URL", profileConfig))}`],
    ["client id", endpoints.clientId
      ? `${endpoints.clientId} ${style.grey(origin("clientId", "POWERFARM_CLIENT_ID", profileConfig))}`
      : style.red("not configured")],
  ]);

  if (!endpoints.clientId && !DEFAULTS.clientId) {
    out();
    out(`${mark.warn()} No OAuth client id. ${style.grey("Run `powerfarm doctor` for the fix.")}`);
  }
  if (!session && !stored) {
    out();
    out(`${mark.info()} Run ${style.cyan("powerfarm login")} to authenticate.`);
  }
  return session ? 0 : 4;
}
