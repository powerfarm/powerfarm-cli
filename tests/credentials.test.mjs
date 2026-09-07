import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The credential store reads its location from the environment at call time,
// so point it at a throwaway directory before importing anything that uses it.
const scratch = await mkdtemp(join(tmpdir(), "powerfarm-cli-"));
process.env.POWERFARM_CONFIG_DIR = scratch;

const {
  clearAllCredentials, clearCredential, getCredential,
  readConfig, saveCredential, writeConfig,
} = await import("../src/lib/credentials.mjs");
const { activeProfile, resolveEndpoints, allLoopbackRedirects } =
  await import("../src/lib/config.mjs");

test("a saved credential round-trips and is stored 0600", async () => {
  await saveCredential("default", { accessToken: "at", refreshToken: "rt" });
  assert.deepEqual(await getCredential("default"), { accessToken: "at", refreshToken: "rt" });

  const info = await stat(join(scratch, "credentials.json"));
  assert.equal(info.mode & 0o777, 0o600, "credentials must not be readable by other users");
});

test("profiles are isolated from one another", async () => {
  await saveCredential("staging", { accessToken: "staging-token" });
  assert.equal((await getCredential("default")).accessToken, "at");
  assert.equal((await getCredential("staging")).accessToken, "staging-token");
  assert.equal(await getCredential("never-used"), null);
});

test("clearing one profile leaves the others signed in", async () => {
  assert.equal(await clearCredential("staging"), true);
  assert.equal(await getCredential("staging"), null);
  assert.ok(await getCredential("default"));
  assert.equal(await clearCredential("staging"), false, "clearing twice is not an error");
});

test("clearing everything removes the file", async () => {
  assert.equal(await clearAllCredentials(), true);
  assert.equal(await getCredential("default"), null);
  assert.equal(await clearAllCredentials(), false);
});

test("a missing or corrupt config falls back instead of crashing", async () => {
  const config = await readConfig();
  assert.deepEqual(config, { defaultProfile: "default", profiles: {} });
  await writeConfig({ defaultProfile: "staging", profiles: { staging: { apiUrl: "https://s.example" } } });
  assert.equal((await readConfig()).defaultProfile, "staging");
});

test("profile precedence is flag over env over config", async () => {
  const config = await readConfig();
  assert.equal(activeProfile("flagged", config), "flagged");
  process.env.POWERFARM_PROFILE = "from-env";
  assert.equal(activeProfile(undefined, config), "from-env");
  delete process.env.POWERFARM_PROFILE;
  assert.equal(activeProfile(undefined, config), "staging");
  assert.equal(activeProfile(undefined, {}), "default");
});

test("endpoints resolve profile over env over default, and derive the issuer", async () => {
  const fromDefault = resolveEndpoints({});
  assert.equal(fromDefault.issuerUrl, `${fromDefault.apiUrl}/auth/v1`);

  process.env.POWERFARM_API_URL = "https://env.example/";
  assert.equal(resolveEndpoints({}).apiUrl, "https://env.example");

  const pinned = resolveEndpoints({ apiUrl: "https://profile.example" });
  assert.equal(pinned.apiUrl, "https://profile.example");
  assert.equal(pinned.issuerUrl, "https://profile.example/auth/v1");
  delete process.env.POWERFARM_API_URL;
});

test("every loopback redirect is a literal 127.0.0.1 address", () => {
  const redirects = allLoopbackRedirects();
  assert.ok(redirects.length >= 2, "need a fallback port");
  for (const uri of redirects) {
    assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  }
  assert.equal(new Set(redirects).size, redirects.length);
});
