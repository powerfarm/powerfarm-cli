import { stat } from "node:fs/promises";
import { parse } from "../lib/args.mjs";
import { createClient } from "../lib/api.mjs";
import { allLoopbackRedirects, LOOPBACK_PORTS } from "../lib/config.mjs";
import { credentialLocation, getCredential } from "../lib/credentials.mjs";
import { probePorts } from "../lib/loopback.mjs";
import { discover, refreshTokens, userInfo } from "../lib/oauth.mjs";
import { json, mark, out, style } from "../lib/output.mjs";
import { loadContext, resolveSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm doctor")} — find out why something is broken.

USAGE
  powerfarm doctor [--json]

Runs live checks against the issuer, the Registry, the Identity host, the
local install, and the places the Registry admits. Exits non-zero if any
check fails, so it can gate CI.
`;

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";
const SKIP = "skip";

export async function run(argv) {
  const { flags } = parse(argv);
  const checks = [];
  const record = (name, status, detail, hint) =>
    checks.push({ name, status, detail, hint });

  const context = await loadContext({ profile: flags.profile });
  const { endpoints, profileName } = context;

  // 1. Runtime ------------------------------------------------------------
  const [major, minor] = process.versions.node.split(".").map(Number);
  record("node runtime",
    major > 20 || (major === 20 && minor >= 11) ? PASS : FAIL,
    `node ${process.versions.node}`,
    "Powerfarm needs Node 20.11 or newer.");

  // 2. Credential file permissions ---------------------------------------
  const where = credentialLocation();
  try {
    const info = await stat(where.credentials);
    const mode = info.mode & 0o777;
    record("credential permissions",
      mode === 0o600 ? PASS : WARN,
      `${where.credentials} is ${mode.toString(8).padStart(3, "0")}`,
      mode === 0o600 ? undefined : "Run `chmod 600` on it — other users on this machine can read your token.");
  } catch (error) {
    record("credential permissions", error.code === "ENOENT" ? SKIP : WARN,
      error.code === "ENOENT" ? "no credentials stored yet" : error.message);
  }

  // 3. Issuer discovery ---------------------------------------------------
  let metadata = null;
  let issuerDate = null;
  try {
    const response = await fetch(`${endpoints.issuerUrl}/.well-known/oauth-authorization-server`);
    const body = await response.text();
    try {
      metadata = JSON.parse(body);
    } catch {
      // A proxy or captive portal answering instead of the issuer. Its Date
      // header is not the issuer's, so the skew check must not use it.
      throw new Error(
        `${endpoints.issuerUrl} answered with ${response.status} but not JSON — something is intercepting the request`,
      );
    }
    issuerDate = response.headers.get("date");
    const grants = metadata.grant_types_supported ?? [];
    const missing = ["authorization_code", "refresh_token"].filter((g) => !grants.includes(g));
    const s256 = (metadata.code_challenge_methods_supported ?? []).includes("S256");
    record("issuer discovery",
      missing.length === 0 && s256 ? PASS : FAIL,
      missing.length
        ? `missing grant types: ${missing.join(", ")}`
        : `${endpoints.issuerUrl} · S256 ${s256 ? "supported" : "missing"}`);

    // A device grant would let the CLI stop running a local server entirely.
    const device = grants.includes("urn:ietf:params:oauth:grant-type:device_code");
    record("device code grant", device ? PASS : SKIP,
      device
        ? "supported — the CLI can drop the loopback server"
        : "not offered by this issuer; loopback redirect is the only option");
  } catch (error) {
    record("issuer discovery", FAIL, error.message,
      "The CLI cannot authenticate at all until the issuer is reachable.");
  }

  // 4. Clock skew ---------------------------------------------------------
  if (issuerDate) {
    const skew = Math.abs(Date.now() - new Date(issuerDate).getTime()) / 1000;
    record("clock skew",
      skew < 60 ? PASS : skew < 300 ? WARN : FAIL,
      `${skew.toFixed(0)}s from the issuer`,
      skew < 60 ? undefined : "Token validation fails in confusing ways when the clock drifts. Enable NTP.");
  }

  // 5. Client id ----------------------------------------------------------
  record("oauth client id",
    endpoints.clientId ? PASS : FAIL,
    endpoints.clientId || "not configured",
    endpoints.clientId
      ? undefined
      : "Register a public client with the loopback redirects, then set POWERFARM_CLIENT_ID.");

  // 6. Loopback ports -----------------------------------------------------
  const ports = await probePorts();
  const free = ports.filter((port) => port.free);
  record("loopback ports",
    free.length > 0 ? (free.length === ports.length ? PASS : WARN) : FAIL,
    `${free.length}/${ports.length} free (${LOOPBACK_PORTS.join(", ")})`,
    free.length ? undefined : "Every callback port is taken. Use `powerfarm login --token`.");

  // 7. Session ------------------------------------------------------------
  let session = null;
  const stored = await getCredential(profileName);
  try {
    session = await resolveSession(context);
    record("session", session ? PASS : SKIP,
      session ? `authenticated via ${session.source}` : "not signed in",
      session ? undefined : "Run `powerfarm login`.");
  } catch (error) {
    record("session", FAIL, error.message, "Try `powerfarm logout` then `powerfarm login`.");
  }

  // 8. Token actually works ----------------------------------------------
  if (session) {
    try {
      const profile = await userInfo({
        issuerUrl: endpoints.issuerUrl,
        accessToken: session.accessToken,
      });
      record("access token", profile ? PASS : FAIL,
        profile ? `userinfo returned ${profile.email ?? profile.sub}` : "userinfo rejected the token");
    } catch (error) {
      record("access token", FAIL, error.message);
    }

    // A real refresh, not just an expiry comparison — this is the thing that
    // silently rots and only shows up days later.
    const refreshToken = stored?.refreshToken ?? process.env.POWERFARM_TOKEN;
    if (refreshToken) {
      try {
        await refreshTokens({
          issuerUrl: endpoints.issuerUrl,
          clientId: endpoints.clientId,
          refreshToken,
        });
        record("refresh token", PASS, "exchanged successfully");
      } catch (error) {
        record("refresh token", FAIL, error.message,
          "You will be signed out when the access token expires. Sign in again.");
      }
    } else {
      record("refresh token", WARN, "none stored",
        "Without one you must re-authenticate every hour.");
    }
  }

  // 9. Client registration shape -----------------------------------------
  if (session && endpoints.clientId) {
    try {
      const client = createClient({ endpoints, accessToken: session.accessToken });
      const { clients } = await client.registry("/api/oauth/clients", {}, "list OAuth clients");
      const mine = (clients ?? []).find((entry) => entry.client_id === endpoints.clientId);
      if (!mine) {
        record("client registration", WARN,
          "this client id is not visible to your account",
          "Either it belongs to another account, or it was never registered.");
      } else {
        const isPublic = mine.token_endpoint_auth_method === "none";
        record("public client", isPublic ? PASS : FAIL,
          `token_endpoint_auth_method: ${mine.token_endpoint_auth_method}`,
          isPublic ? undefined : "A CLI must be a public client; a confidential one implies a secret in the binary.");

        const registered = new Set(
          typeof mine.redirect_uris === "string"
            ? mine.redirect_uris.split(",").map((uri) => uri.trim())
            : mine.redirect_uris ?? [],
        );
        const missing = allLoopbackRedirects().filter((uri) => !registered.has(uri));
        record("loopback redirects",
          missing.length === 0 ? PASS : missing.length < LOOPBACK_PORTS.length ? WARN : FAIL,
          missing.length ? `missing ${missing.length}: ${missing.join(", ")}` : "all registered",
          missing.length
            ? "Registration silently drops http loopback URIs unless the client allows them. See oauth-admin.mjs."
            : undefined);
      }
    } catch (error) {
      record("client registration", SKIP, error.message,
        "Needs the oauth.clients.manage grant, and a Registry that accepts bearer tokens.");
    }
  }

  // 10. Hosts -------------------------------------------------------------
  for (const [name, url] of [
    ["registry host", endpoints.registryUrl],
    ["identity host", `${endpoints.identityUrl}/oauth/consent`],
  ]) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      // A redirect is healthy — both hosts bounce anonymous callers to a login
      // page. 401/403 means something answered but refused, which is usually a
      // proxy rather than the app, so it is a warning, not a pass.
      const status = response.status < 400 ? PASS
        : response.status === 401 || response.status === 403 ? WARN
          : FAIL;
      record(name, status, `HTTP ${response.status} from ${url}`,
        status === PASS
          ? undefined
          : status === WARN
            ? "Something answered but refused. Check for a proxy between you and this host."
            : "This host must answer or sign-in cannot complete.");
    } catch (error) {
      record(name, FAIL, error.message);
    }
  }

  // 11. Places ------------------------------------------------------------
  if (session) {
    try {
      const client = createClient({ endpoints, accessToken: session.accessToken });
      const places = await client.rest("identities", {
        select: "slug,name,metadata,contract_version",
        kind: "eq.place",
        order: "slug.asc",
      }, "list places");
      const expected = [
        "pf.engine-park.512",
        "pf.app-park.512",
        "pf.engine-park.8gb",
        "pf.app-park.8gb",
      ];
      const have = new Set((places ?? []).map((place) => place.slug));
      const missing = expected.filter((slug) => !have.has(slug));
      record("places registered",
        missing.length === 0 ? PASS : (places ?? []).length ? WARN : FAIL,
        missing.length
          ? `missing ${missing.join(", ")}`
          : `${places.length} parks admitted`,
        missing.length ? "Register the four parks after the machines they sit on." : undefined);

      const machines = await client.rest("identities", {
        select: "slug,contract_version",
        kind: "eq.machine",
      }, "list machines");
      const machineSlugs = new Set((machines ?? []).map((row) => row.slug));
      record("machine 512",
        machineSlugs.has("pf.lab-512") ? PASS : FAIL,
        machineSlugs.has("pf.lab-512") ? "pf.lab-512 admitted" : "pf.lab-512 is not registered",
        machineSlugs.has("pf.lab-512") ? undefined : "Register the 512 machine before its parks.");

      const unbound = (places ?? []).filter((place) => !machineSlugs.has(place.metadata?.machine));
      record("place machines",
        unbound.length === 0 ? PASS : FAIL,
        unbound.length
          ? `unbound: ${unbound.map((place) => place.slug).join(", ")}`
          : "every place names a registered machine");
    } catch (error) {
      record("places registered", SKIP, error.message);
    }
  }

  // Report ----------------------------------------------------------------
  const failed = checks.filter((check) => check.status === FAIL);
  const warned = checks.filter((check) => check.status === WARN);

  if (flags.json) {
    json({ checks, failed: failed.length, warned: warned.length });
    return failed.length ? 1 : 0;
  }

  const glyph = { pass: mark.ok(), warn: mark.warn(), fail: mark.fail(), skip: style.grey("-") };
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    out(`${glyph[check.status]} ${check.name.padEnd(width)}  ${style.grey(check.detail ?? "")}`);
    if (check.hint && check.status !== PASS) out(`  ${" ".repeat(width)}${style.yellow(check.hint)}`);
  }

  out();
  if (failed.length === 0 && warned.length === 0) {
    out(`${mark.ok()} ${style.green("Everything checks out.")}`);
  } else {
    out(`${failed.length} failed, ${warned.length} warned, ${checks.length} checked.`);
  }
  return failed.length ? 1 : 0;
}
