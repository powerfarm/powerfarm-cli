import { activeProfile, resolveEndpoints } from "./config.mjs";
import { getCredential, readConfig, saveCredential } from "./credentials.mjs";
import { AuthRequiredError } from "./errors.mjs";
import { isExpired, refreshTokens } from "./oauth.mjs";

/**
 * Resolve the whole execution context for a command: which profile, which
 * endpoints, and a usable access token.
 *
 * Auth modes, in precedence order:
 *   1. POWERFARM_TOKEN  — a refresh token supplied by CI. Never written to disk.
 *   2. the stored credential for the active profile, refreshed if stale.
 */
export async function loadContext({ profile: profileFlag } = {}) {
  const config = await readConfig();
  const name = activeProfile(profileFlag, config);
  const endpoints = resolveEndpoints(config.profiles?.[name]);
  return { profileName: name, config, endpoints };
}

export async function requireSession(options = {}) {
  const context = await loadContext(options);
  const session = await resolveSession(context);
  if (!session) throw new AuthRequiredError();
  return { ...context, ...session };
}

export async function resolveSession(context) {
  const { endpoints, profileName } = context;

  const ciToken = process.env.POWERFARM_TOKEN;
  if (ciToken) {
    const tokens = await refreshTokens({
      issuerUrl: endpoints.issuerUrl,
      clientId: endpoints.clientId,
      refreshToken: ciToken,
    });
    return { accessToken: tokens.accessToken, credential: tokens, source: "env" };
  }

  const credential = await getCredential(profileName);
  if (!credential) return null;

  if (!isExpired(credential)) {
    return { accessToken: credential.accessToken, credential, source: credential.source ?? "browser" };
  }
  if (!credential.refreshToken) return null;

  const tokens = await refreshTokens({
    issuerUrl: endpoints.issuerUrl,
    clientId: endpoints.clientId,
    refreshToken: credential.refreshToken,
  });
  const renewed = { ...credential, ...tokens };
  await saveCredential(profileName, renewed);
  return { accessToken: renewed.accessToken, credential: renewed, source: renewed.source ?? "browser" };
}
