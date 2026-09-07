import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Production defaults. Every one of these is overridable by environment
 * variable so the same binary drives local, preview and production.
 *
 * The publishable key is safe to ship: it is the browser-facing key and every
 * table it can reach is behind RLS.
 */
export const DEFAULTS = {
  apiUrl: "https://wmsrqefgdgcijupeogfa.supabase.co",
  registryUrl: "https://registry.powerfarm.app",
  identityUrl: "https://id.powerfarm.app",
  publishableKey: "sb_publishable_oC_uzaP33cbOVgu4BM_rLQ_1Sj2VfO_",
  // Registered as a public client (token_endpoint_auth_method: none) carrying
  // the loopback redirect URIs below. There is no client secret in this
  // package, and there must never be one: PKCE is what protects the exchange.
  // A public client id is not a credential — it is published in every
  // authorization request — so shipping it here is correct.
  clientId: "8a926787-1bbe-4ff4-a849-204b1f05d59c",
  scope: "openid email profile offline_access",
};

/**
 * Fixed loopback ports. RFC 8252 says an authorization server SHOULD ignore
 * the port for loopback redirects, but Supabase matches redirect_uris exactly,
 * so the CLI claims a small set of known ports and registers all of them.
 */
export const LOOPBACK_PORTS = [51789, 51790, 51791, 51792];
export const LOOPBACK_PATH = "/callback";

export function loopbackRedirect(port) {
  return `http://127.0.0.1:${port}${LOOPBACK_PATH}`;
}

export function allLoopbackRedirects() {
  return LOOPBACK_PORTS.map(loopbackRedirect);
}

export function configDir() {
  if (process.env.POWERFARM_CONFIG_DIR) return process.env.POWERFARM_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "powerfarm");
  return join(homedir(), ".config", "powerfarm");
}

export const configPath = () => join(configDir(), "config.json");
export const credentialsPath = () => join(configDir(), "credentials.json");

/** The profile currently in play: --profile beats env beats config default. */
export function activeProfile(flag, stored) {
  return flag || process.env.POWERFARM_PROFILE || stored?.defaultProfile || "default";
}

/**
 * Resolve endpoints for a profile. A profile may pin its own URLs (a preview
 * deployment, a local stack); anything it does not pin falls back to the
 * environment, then to the production defaults.
 */
export function resolveEndpoints(profile = {}) {
  const pick = (key, envName, fallback) =>
    profile[key] || process.env[envName] || fallback;
  const apiUrl = trimSlash(pick("apiUrl", "POWERFARM_API_URL", DEFAULTS.apiUrl));
  return {
    apiUrl,
    issuerUrl: `${apiUrl}/auth/v1`,
    registryUrl: trimSlash(pick("registryUrl", "POWERFARM_REGISTRY_URL", DEFAULTS.registryUrl)),
    identityUrl: trimSlash(pick("identityUrl", "POWERFARM_IDENTITY_URL", DEFAULTS.identityUrl)),
    publishableKey: pick("publishableKey", "POWERFARM_PUBLISHABLE_KEY", DEFAULTS.publishableKey),
    clientId: pick("clientId", "POWERFARM_CLIENT_ID", DEFAULTS.clientId),
    scope: DEFAULTS.scope,
  };
}

function trimSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}
