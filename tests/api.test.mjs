import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../src/lib/api.mjs";

const ENDPOINTS = {
  apiUrl: "https://project.supabase.co",
  registryUrl: "https://registry.example.test",
  publishableKey: "sb_publishable_test",
};

/** A stand-in for a fetch Response; only the fields api.mjs reads. */
function reply({ status = 200, body = "", redirected = false, url = "https://registry.example.test/api/x" }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected,
    url,
    text: async () => body,
  };
}

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

const client = () => createClient({ endpoints: ENDPOINTS, accessToken: "token" });

test("a registry redirect to a sign-in page is a failure, not an empty result", async () => {
  // The regression this guards: the registry answered 307 -> /login, fetch
  // followed it, and the HTML sign-in page arrived as a 200. `const { clients }
  // = <html>` was undefined, so `oauth clients list` reported "No OAuth clients
  // are registered" while the provider held four -- including the CLI itself.
  await withFetch(
    async () => reply({
      status: 200,
      redirected: true,
      url: "https://id.example.test/login",
      body: "<!DOCTYPE html><html><title>Sign in</title></html>",
    }),
    async () => {
      await assert.rejects(
        () => client().registry("/api/oauth/clients", {}, "list OAuth clients"),
        (error) => {
          assert.match(error.message, /redirected to https:\/\/id\.example\.test\/login/);
          assert.match(error.hint, /did not accept the bearer token/);
          return true;
        },
      );
    },
  );
});

test("an HTML body is never handed back as data", async () => {
  await withFetch(
    async () => reply({ status: 200, body: "<!doctype html><html>nope</html>" }),
    async () => {
      await assert.rejects(
        () => client().registry("/api/oauth/clients", {}, "list OAuth clients"),
        /returned an HTML page, not JSON/,
      );
    },
  );
});

test("401 blames the token and points at login, not at grants", async () => {
  await withFetch(
    async () => reply({ status: 401, body: JSON.stringify({ msg: "invalid claim: missing sub" }) }),
    async () => {
      await assert.rejects(
        () => client().rest("grants", {}, "read your grants"),
        (error) => {
          assert.match(error.message, /access token was rejected/);
          assert.match(error.message, /missing sub/);
          assert.match(error.hint, /powerfarm login/);
          return true;
        },
      );
    },
  );
});

test("403 blames grants and repeats what the server said", async () => {
  await withFetch(
    async () => reply({ status: 403, body: JSON.stringify({ message: "row-level security" }) }),
    async () => {
      await assert.rejects(
        () => client().rest("grants", {}, "read your grants"),
        (error) => {
          assert.match(error.message, /Refused to read your grants: row-level security/);
          assert.match(error.hint, /grants may not cover/);
          return true;
        },
      );
    },
  );
});

test("a normal JSON answer still comes back untouched", async () => {
  await withFetch(
    async () => reply({ status: 200, body: JSON.stringify([{ action: "registry.admin" }]) }),
    async () => {
      const rows = await client().rest("grants", {}, "read your grants");
      assert.deepEqual(rows, [{ action: "registry.admin" }]);
    },
  );
});

test("an empty body is still a valid answer", async () => {
  await withFetch(
    async () => reply({ status: 200, body: "" }),
    async () => assert.equal(await client().rest("grants", {}, "read your grants"), null),
  );
});
