import { parse } from "../lib/args.mjs";
import { canOpenBrowser, openBrowser } from "../lib/browser.mjs";
import { allLoopbackRedirects, loopbackRedirect } from "../lib/config.mjs";
import { saveCredential, writeConfig } from "../lib/credentials.mjs";
import { CliError } from "../lib/errors.mjs";
import { startCallbackServer } from "../lib/loopback.mjs";
import { createAuthorization, exchangeCode, refreshTokens, userInfo } from "../lib/oauth.mjs";
import { json, mark, out, style } from "../lib/output.mjs";
import { askSecret } from "../lib/prompt.mjs";
import { loadContext } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm login")} — authenticate this machine.

USAGE
  powerfarm login [options]

OPTIONS
  --token              Paste a token instead of opening a browser
  --no-browser         Print the URL rather than launching a browser
  --profile <name>     Store the credential under a named profile
  --set-default        Make this profile the default after signing in
  --json               Print the resulting session as JSON

MODES
  Browser (default)  Opens Identity, catches the code on ${loopbackRedirect(51789)}
                     and exchanges it with PKCE. No secret is stored anywhere.
  --token            For SSH sessions and machines with no browser. Paste a
                     refresh token; it is exchanged immediately and stored.
  POWERFARM_TOKEN    For CI. Set the variable and skip login entirely — the
                     token is used in memory and never written to disk.
`;

export async function run(argv) {
  const { flags } = parse(argv, {
    token: { type: "boolean", default: false },
    "no-browser": { type: "boolean", default: false },
    "set-default": { type: "boolean", default: false },
  });

  const context = await loadContext({ profile: flags.profile });
  const { endpoints, profileName } = context;

  if (process.env.POWERFARM_TOKEN && !flags.token) {
    out(`${mark.info()} POWERFARM_TOKEN is set; this shell is already authenticated.`);
    out(`  ${style.grey("Unset it to sign in interactively.")}`);
    return 0;
  }

  const tokens = flags.token
    ? await pasteToken(endpoints)
    : await browserLogin(endpoints, { noBrowser: flags["no-browser"], quiet: flags.quiet });

  const profile = await userInfo({
    issuerUrl: endpoints.issuerUrl,
    accessToken: tokens.accessToken,
  });

  await saveCredential(profileName, {
    ...tokens,
    source: flags.token ? "token" : "browser",
    subject: profile?.sub ?? null,
    email: profile?.email ?? null,
    issuer: endpoints.issuerUrl,
    savedAt: new Date().toISOString(),
  });

  if (flags["set-default"]) {
    const config = context.config;
    config.defaultProfile = profileName;
    await writeConfig(config);
  }

  if (flags.json) {
    json({ profile: profileName, subject: profile?.sub ?? null, email: profile?.email ?? null });
    return 0;
  }

  out(`${mark.ok()} Signed in as ${style.bold(profile?.email ?? profile?.sub ?? "unknown")}`);
  out(`  ${style.grey(`profile ${profileName} · ${endpoints.registryUrl}`)}`);
  return 0;
}

async function browserLogin(endpoints, { noBrowser, quiet }) {
  // Bind first, then build the URL around the port we actually got.
  const server = await startCallbackServer();
  const authorization = createAuthorization({
    issuerUrl: endpoints.issuerUrl,
    clientId: endpoints.clientId,
    redirectUri: server.redirectUri,
    scope: endpoints.scope,
  });

  const pending = server.waitForCode({ expectedState: authorization.state });

  const opened = !noBrowser && canOpenBrowser() && openBrowser(authorization.authorizationUrl);
  if (!quiet) {
    if (opened) {
      out(`${mark.info()} Opening your browser to sign in…`);
      out(`  ${style.grey("If nothing opens, visit:")}`);
    } else {
      out(`${mark.info()} Open this URL to sign in:`);
    }
    out(`  ${style.cyan(authorization.authorizationUrl)}`);
    out();
    out(style.grey("  Waiting for the browser to come back…"));
  }

  const { code, redirectUri } = await pending;
  return exchangeCode({
    issuerUrl: endpoints.issuerUrl,
    clientId: endpoints.clientId,
    redirectUri,
    code,
    codeVerifier: authorization.codeVerifier,
  });
}

async function pasteToken(endpoints) {
  out(`${mark.info()} Create a token in the Registry, then paste it here.`);
  out(`  ${style.grey(`${endpoints.registryUrl}/account`)}`);
  out();
  const token = await askSecret("Token: ");
  if (!token) throw new CliError("No token was entered.");
  return refreshTokens({
    issuerUrl: endpoints.issuerUrl,
    clientId: endpoints.clientId,
    refreshToken: token,
  });
}

export const LOOPBACK_REDIRECTS = allLoopbackRedirects();
