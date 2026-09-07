import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const BIN = fileURLToPath(new URL("../bin/powerfarm.mjs", import.meta.url));
const CLIENT_ID = "11111111-2222-4333-8444-555555555555";

/**
 * A real HTTP OAuth issuer, spoken over real sockets. This is not a fetch
 * stub: the CLI runs as a separate process and everything between them —
 * headers, form encoding, redirects, the loopback handshake — is genuine.
 *
 * It enforces the parts that actually protect the exchange, so a CLI that
 * skipped PKCE or reused a code would fail here.
 */
async function startIssuer() {
  const issued = new Map();
  const consumed = new Set();
  const state = { tokenRequests: [], refreshCount: 0 };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (code, body) => {
      response.writeHead(code, { "Content-Type": "application/json", Connection: "close" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/auth/v1/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: "http://127.0.0.1/auth/v1",
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
      });
    }

    if (url.pathname === "/auth/v1/oauth/authorize") {
      const params = url.searchParams;
      // The issuer refuses anything that is not a correct PKCE public-client
      // request, so a regression in the CLI shows up as a failed login.
      assert.equal(params.get("response_type"), "code");
      assert.equal(params.get("client_id"), CLIENT_ID);
      assert.equal(params.get("code_challenge_method"), "S256");
      const code = randomUUID();
      issued.set(code, {
        challenge: params.get("code_challenge"),
        redirectUri: params.get("redirect_uri"),
      });
      const back = new URL(params.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", params.get("state"));
      response.writeHead(302, { Location: back.toString(), Connection: "close" });
      return response.end();
    }

    if (url.pathname === "/auth/v1/oauth/token") {
      const body = new URLSearchParams(await readBody(request));
      state.tokenRequests.push({ body, headers: request.headers });

      // A public client must not send a secret, and must not use Basic auth.
      if (body.get("client_secret") || request.headers.authorization) {
        return send(400, { error: "invalid_client", error_description: "public client sent a secret" });
      }

      if (body.get("grant_type") === "refresh_token") {
        state.refreshCount += 1;
        if (body.get("refresh_token") !== "refresh-1") {
          return send(400, { error: "invalid_grant", error_description: "unknown refresh token" });
        }
        return send(200, {
          access_token: "access-2", refresh_token: "refresh-1",
          expires_in: 3600, token_type: "bearer",
        });
      }

      const code = body.get("code");
      const record = issued.get(code);
      if (!record) return send(400, { error: "invalid_grant", error_description: "unknown code" });
      // Single use.
      if (consumed.has(code)) return send(400, { error: "invalid_grant", error_description: "code replayed" });
      consumed.add(code);

      const verifier = body.get("code_verifier") ?? "";
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (computed !== record.challenge) {
        return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      if (body.get("redirect_uri") !== record.redirectUri) {
        return send(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }
      return send(200, {
        access_token: "access-1", refresh_token: "refresh-1",
        expires_in: 3600, token_type: "bearer",
      });
    }

    if (url.pathname === "/auth/v1/oauth/userinfo") {
      if (!/^Bearer access-\d$/.test(request.headers.authorization ?? "")) {
        return send(401, { error: "invalid_token" });
      }
      return send(200, { sub: "user-1", email: "dan@powerfarm.app" });
    }

    // Minimal PostgREST surface, so `status` and `whoami` exercise the real
    // client rather than being skipped.
    if (url.pathname === "/rest/v1/identity_links") {
      return send(200, [{
        identity_id: "id-1", linked_at: "2026-08-18T00:00:00Z",
        identities: { id: "id-1", name: "danvoulez", kind: "person" },
      }]);
    }
    if (url.pathname === "/rest/v1/grants") {
      return send(200, [{ action: "registry.admin" }, { action: "oauth.clients.manage" }]);
    }
    if (url.pathname === "/rest/v1/workspaces") {
      return send(200, [{ id: "ws-1", slug: "danvoulez", title: "Dan Voullez" }]);
    }
    return send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => resolve(data));
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Start `login`, and act as the browser as soon as it prints the URL. */
function loginWithBrowser(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "login", "--no-browser"], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let visited = false;

    child.stdout.on("data", async (chunk) => {
      stdout += chunk;
      const match = stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/auth\/v1\/oauth\/authorize\S+)/);
      if (match && !visited) {
        visited = true;
        try {
          // Follow the issuer's redirect back into the CLI's loopback server,
          // exactly as a browser would.
          const hop = await fetch(match[1], { redirect: "manual" });
          const location = hop.headers.get("location");
          assert.ok(location, "the issuer did not redirect back");
          const landed = await fetch(location);
          assert.equal(landed.status, 200);
        } catch (error) {
          child.kill();
          reject(error);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr, visited }));
  });
}

test("a full login round trip: authorize, callback, PKCE exchange, stored session", async (t) => {
  const issuer = await startIssuer();
  const configDir = await mkdtemp(join(tmpdir(), "powerfarm-e2e-"));
  t.after(() => issuer.close());

  const env = {
    POWERFARM_API_URL: issuer.origin,
    POWERFARM_REGISTRY_URL: issuer.origin,
    POWERFARM_IDENTITY_URL: issuer.origin,
    POWERFARM_CLIENT_ID: CLIENT_ID,
    POWERFARM_CONFIG_DIR: configDir,
    POWERFARM_NO_BROWSER: "1",
    POWERFARM_TOKEN: "",
    NO_COLOR: "1",
  };

  const login = await loginWithBrowser(env);
  assert.equal(login.visited, true, "the CLI never printed an authorization URL");
  assert.equal(login.code, 0, `login failed: ${login.stderr}`);
  assert.match(login.stdout, /Signed in as dan@powerfarm\.app/);

  // The exchange really was a public-client PKCE exchange.
  const exchange = issuer.state.tokenRequests.at(0);
  assert.equal(exchange.body.get("grant_type"), "authorization_code");
  assert.equal(exchange.body.get("client_id"), CLIENT_ID);
  assert.ok(exchange.body.get("code_verifier"), "no PKCE verifier was sent");
  assert.equal(exchange.body.get("client_secret"), null);
  assert.equal(exchange.headers.authorization, undefined);

  // The credential landed on disk, private.
  const info = await stat(join(configDir, "credentials.json"));
  assert.equal(info.mode & 0o777, 0o600);

  // And the session is usable by other commands.
  const status = await runCli(["status", "--json"], env);
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.email, "dan@powerfarm.app");
  assert.equal(parsed.source, "browser");
  assert.deepEqual(parsed.grants.sort(), ["oauth.clients.manage", "registry.admin"]);

  const whoami = await runCli(["whoami", "--json"], env);
  assert.equal(whoami.code, 0, whoami.stderr);
  assert.equal(JSON.parse(whoami.stdout).identity.name, "danvoulez");
});

test("an expired access token is refreshed transparently", async (t) => {
  const issuer = await startIssuer();
  const configDir = await mkdtemp(join(tmpdir(), "powerfarm-e2e-"));
  t.after(() => issuer.close());

  const env = {
    POWERFARM_API_URL: issuer.origin,
    POWERFARM_CLIENT_ID: CLIENT_ID,
    POWERFARM_CONFIG_DIR: configDir,
    POWERFARM_NO_BROWSER: "1",
    NO_COLOR: "1",
  };

  await loginWithBrowser(env);

  // Age the stored credential past expiry.
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = join(configDir, "credentials.json");
  const store = JSON.parse(await readFile(path, "utf8"));
  store.profiles.default.expiresAt = new Date(Date.now() - 60_000).toISOString();
  store.profiles.default.accessToken = "access-stale";
  await writeFile(path, JSON.stringify(store));

  const before = issuer.state.refreshCount;
  const status = await runCli(["status", "--json"], env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).authenticated, true);
  assert.ok(issuer.state.refreshCount > before, "the CLI did not refresh");

  // The renewed token was written back, so the next command does not refresh again.
  const renewed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(renewed.profiles.default.accessToken, "access-2");
});

test("POWERFARM_TOKEN authenticates CI without touching the credential store", async (t) => {
  const issuer = await startIssuer();
  const configDir = await mkdtemp(join(tmpdir(), "powerfarm-e2e-"));
  t.after(() => issuer.close());

  const status = await runCli(["status", "--json"], {
    POWERFARM_API_URL: issuer.origin,
    POWERFARM_CLIENT_ID: CLIENT_ID,
    POWERFARM_CONFIG_DIR: configDir,
    POWERFARM_TOKEN: "refresh-1",
    NO_COLOR: "1",
  });

  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.source, "env");

  // Nothing was persisted: a CI token must not linger on a shared runner.
  await assert.rejects(stat(join(configDir, "credentials.json")), /ENOENT/);
});

test("logout leaves the CLI genuinely signed out", async (t) => {
  const issuer = await startIssuer();
  const configDir = await mkdtemp(join(tmpdir(), "powerfarm-e2e-"));
  t.after(() => issuer.close());

  const env = {
    POWERFARM_API_URL: issuer.origin,
    POWERFARM_CLIENT_ID: CLIENT_ID,
    POWERFARM_CONFIG_DIR: configDir,
    POWERFARM_NO_BROWSER: "1",
    NO_COLOR: "1",
  };

  await loginWithBrowser(env);
  assert.equal(JSON.parse((await runCli(["status", "--json"], env)).stdout).authenticated, true);

  const out = await runCli(["logout"], env);
  assert.equal(out.code, 0, out.stderr);

  const after = await runCli(["status", "--json"], env);
  assert.equal(after.code, 4, "a signed-out status must exit 4");
  assert.equal(JSON.parse(after.stdout).authenticated, false);
});

test("doctor passes against a healthy issuer and fails against a broken one", async (t) => {
  const issuer = await startIssuer();
  const configDir = await mkdtemp(join(tmpdir(), "powerfarm-e2e-"));
  t.after(() => issuer.close());

  const env = {
    POWERFARM_API_URL: issuer.origin,
    POWERFARM_REGISTRY_URL: issuer.origin,
    POWERFARM_IDENTITY_URL: issuer.origin,
    POWERFARM_CLIENT_ID: CLIENT_ID,
    POWERFARM_CONFIG_DIR: configDir,
    POWERFARM_NO_BROWSER: "1",
    NO_COLOR: "1",
  };

  await loginWithBrowser(env);
  const healthy = await runCli(["doctor", "--json"], env);
  const checks = JSON.parse(healthy.stdout).checks;
  const byName = Object.fromEntries(checks.map((check) => [check.name, check.status]));

  assert.equal(byName["issuer discovery"], "pass");
  assert.equal(byName["oauth client id"], "pass");
  assert.equal(byName["access token"], "pass");
  assert.equal(byName["refresh token"], "pass");
  assert.equal(byName["credential permissions"], "pass");
  assert.equal(byName["session"], "pass");

  // Point it at a dead port: doctor must fail, not report health.
  const broken = await runCli(["doctor", "--json"], {
    ...env, POWERFARM_API_URL: "http://127.0.0.1:9", POWERFARM_REGISTRY_URL: "http://127.0.0.1:9",
  });
  assert.equal(broken.code, 1, "doctor must exit non-zero when the issuer is unreachable");
  const brokenChecks = JSON.parse(broken.stdout).checks;
  assert.equal(brokenChecks.find((c) => c.name === "issuer discovery").status, "fail");
  // The bug this caught once already: skew must not be reported when discovery failed.
  assert.equal(brokenChecks.find((c) => c.name === "clock skew"), undefined);
});
