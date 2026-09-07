import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthorization,
  exchangeCode,
  isExpired,
  issuerBase,
  normalizeTokens,
  refreshTokens,
} from "../src/lib/oauth.mjs";

const ISSUER = "https://project.supabase.co/auth/v1";

test("the authorization request is a PKCE public-client request", () => {
  const authorization = createAuthorization({
    issuerUrl: ISSUER,
    clientId: "cli-client",
    redirectUri: "http://127.0.0.1:51789/callback",
    scope: "openid email profile offline_access",
  });
  const url = new URL(authorization.authorizationUrl);

  assert.equal(url.origin + url.pathname, "https://project.supabase.co/auth/v1/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cli-client");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:51789/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge").length, 43);
  // A secret must never appear in an authorization request.
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.notEqual(authorization.state, authorization.codeVerifier);
});

test("a missing client id fails with an actionable message", () => {
  assert.throws(() => createAuthorization({
    issuerUrl: ISSUER, clientId: "", redirectUri: "http://127.0.0.1:51789/callback", scope: "openid",
  }), /No OAuth client id/);
});

test("the issuer must be HTTPS unless it is loopback", () => {
  assert.equal(issuerBase("https://a.example/auth/v1/"), "https://a.example/auth/v1");
  assert.equal(issuerBase("http://127.0.0.1:54321/auth/v1"), "http://127.0.0.1:54321/auth/v1");
  assert.throws(() => issuerBase("http://evil.example/auth/v1"), /must use HTTPS/);
  assert.throws(() => issuerBase("not-a-url"), /not a valid issuer URL/i);
});

test("the code exchange authenticates with PKCE, never a client secret", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: new URLSearchParams(init.body), headers: init.headers };
    return new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const tokens = await exchangeCode({
    issuerUrl: ISSUER,
    clientId: "cli-client",
    redirectUri: "http://127.0.0.1:51789/callback",
    code: "the-code",
    codeVerifier: "the-verifier",
    fetchImpl,
  });

  assert.equal(seen.url, "https://project.supabase.co/auth/v1/oauth/token");
  assert.equal(seen.body.get("grant_type"), "authorization_code");
  assert.equal(seen.body.get("code_verifier"), "the-verifier");
  assert.equal(seen.body.get("client_id"), "cli-client");
  assert.equal(seen.body.get("client_secret"), null);
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(tokens.accessToken, "at");
  assert.equal(tokens.refreshToken, "rt");
});

test("a rejected exchange surfaces the issuer's own description", async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
  await assert.rejects(
    exchangeCode({ issuerUrl: ISSUER, clientId: "c", redirectUri: "r", code: "x", codeVerifier: "v", fetchImpl }),
    /code expired/,
  );
});

test("refresh sends the refresh grant with the client id", async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ access_token: "new", expires_in: 60 }), { status: 200 });
  };
  const tokens = await refreshTokens({
    issuerUrl: ISSUER, clientId: "cli-client", refreshToken: "old", fetchImpl,
  });
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "old");
  assert.equal(tokens.accessToken, "new");
  assert.equal(tokens.refreshToken, null);
});

test("token expiry is stored a minute early so requests never race it", () => {
  const tokens = normalizeTokens({ access_token: "a", expires_in: 3600 });
  const seconds = (new Date(tokens.expiresAt).getTime() - Date.now()) / 1000;
  assert.ok(seconds > 3500 && seconds <= 3540, `expected ~3540s, got ${seconds}`);

  assert.equal(isExpired({ expiresAt: new Date(Date.now() + 1000).toISOString() }), false);
  assert.equal(isExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() }), true);
  assert.equal(isExpired({ expiresAt: null }), false);
});
