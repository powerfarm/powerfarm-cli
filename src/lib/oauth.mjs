import { CliError } from "./errors.mjs";
import { challengeFor, createState, createVerifier } from "./pkce.mjs";

/**
 * The CLI is a *public* client: it ships no secret, so it authenticates the
 * token exchange with PKCE alone and sends client_id in the body rather than
 * an Authorization header. Anything that adds a client_secret here is a bug.
 */
export function issuerBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Not a valid issuer URL: ${value}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError("The OAuth issuer must use HTTPS.", {
      hint: "Plain http is only accepted for a loopback issuer during local development.",
    });
  }
  return url.toString().replace(/\/+$/, "");
}

export function createAuthorization({ issuerUrl, clientId, redirectUri, scope, random }) {
  if (!clientId) {
    throw new CliError("No OAuth client id is configured for this CLI.", {
      hint: "Set POWERFARM_CLIENT_ID, or register the CLI client with `powerfarm oauth clients create`.",
    });
  }
  const state = createState(random);
  const codeVerifier = createVerifier(random);
  const url = new URL(`${issuerBase(issuerUrl)}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challengeFor(codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return { authorizationUrl: url.toString(), state, codeVerifier, redirectUri };
}

async function tokenRequest(issuerUrl, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${issuerBase(issuerUrl)}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new CliError(`The identity server rejected the request: ${detail}`);
  }
  if (typeof payload.access_token !== "string") {
    throw new CliError("The identity server returned no access token.");
  }
  return normalizeTokens(payload);
}

export function normalizeTokens(payload) {
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    tokenType: payload.token_type ?? "bearer",
    scope: payload.scope ?? null,
    // Renew a minute early so a request never races the expiry.
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(Date.now() + Math.max(expiresIn - 60, 0) * 1000).toISOString()
      : null,
  };
}

export function exchangeCode({ issuerUrl, clientId, redirectUri, code, codeVerifier, fetchImpl }) {
  return tokenRequest(issuerUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  }, fetchImpl);
}

export function refreshTokens({ issuerUrl, clientId, refreshToken, fetchImpl }) {
  return tokenRequest(issuerUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }, fetchImpl);
}

export async function discover(issuerUrl, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${issuerBase(issuerUrl)}/.well-known/oauth-authorization-server`,
  );
  if (!response.ok) {
    throw new CliError(`Issuer discovery failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function userInfo({ issuerUrl, accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`${issuerBase(issuerUrl)}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new CliError(`Could not read the profile: HTTP ${response.status}.`);
  }
  return response.json();
}

/**
 * Treat an unknown expiry as expired.
 *
 * `normalizeTokens` leaves `expiresAt` null when the issuer omits
 * `expires_in`. Reading that as "never expires" pinned the session to a token
 * that could only be discovered as dead by a 401 on the next call. Refreshing
 * instead costs one request; when there is no refresh token to use,
 * `resolveSession` falls through to asking for a fresh sign-in, which is the
 * honest outcome.
 */
export function isExpired(credential, now = Date.now()) {
  if (!credential?.expiresAt) return true;
  const expiresAt = new Date(credential.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt <= now;
}
