import assert from "node:assert/strict";
import test from "node:test";

import { probePorts, startCallbackServer } from "../src/lib/loopback.mjs";

// These run a real HTTP server on real loopback ports and drive it with real
// requests. Nothing here is doubled.
const PORTS = [51890, 51891];

/** Resolve with the rejection reason, attaching the handler synchronously. */
const settle = (promise) => promise.then(
  () => { throw new Error("expected the wait to reject, but it resolved"); },
  (error) => error,
);

test("the callback server returns the code when the state matches", async () => {
  const server = await startCallbackServer({ ports: PORTS });
  const pending = server.waitForCode({ expectedState: "state-abc", timeoutMs: 5000 });

  const response = await fetch(`${server.redirectUri}?code=the-code&state=state-abc`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Signed in/);

  const result = await pending;
  assert.equal(result.code, "the-code");
  assert.equal(result.redirectUri, server.redirectUri);
});

test("a mismatched state is rejected and the code is never returned", async () => {
  const server = await startCallbackServer({ ports: PORTS });
  // Attach the handler before the request so the rejection is never orphaned.
  const settled = settle(server.waitForCode({ expectedState: "expected", timeoutMs: 5000 }));

  const response = await fetch(`${server.redirectUri}?code=stolen&state=attacker`);
  assert.equal(response.status, 400);

  const error = await settled;
  assert.match(error.message, /state mismatch/);
});

test("an issuer error is surfaced with its description", async () => {
  const server = await startCallbackServer({ ports: PORTS });
  const settled = settle(server.waitForCode({ expectedState: "s", timeoutMs: 5000 }));

  await fetch(`${server.redirectUri}?error=access_denied&error_description=user%20said%20no`);
  const error = await settled;
  assert.match(error.message, /access_denied.*user said no/);
});

test("a response with no code is refused even when the state is right", async () => {
  const server = await startCallbackServer({ ports: PORTS });
  const settled = settle(server.waitForCode({ expectedState: "s", timeoutMs: 5000 }));

  await fetch(`${server.redirectUri}?state=s`);
  const error = await settled;
  assert.match(error.message, /no authorization code/);
});

test("the callback server binds loopback only, and frees the port afterwards", async () => {
  const server = await startCallbackServer({ ports: PORTS });
  assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  // While it is held, probing reports the port as taken.
  const held = await probePorts([server.port]);
  assert.equal(held[0].free, false);

  server.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const released = await probePorts([server.port]);
  assert.equal(released[0].free, true);
});

test("binding falls through to the next port when the first is taken", async () => {
  const first = await startCallbackServer({ ports: PORTS });
  const second = await startCallbackServer({ ports: PORTS });
  assert.notEqual(first.port, second.port);
  assert.equal(second.port, PORTS[1]);
  first.close();
  second.close();
});

test("paths other than /callback are 404 and do not resolve the wait", async () => {
  const server = await startCallbackServer({ ports: PORTS });
  const pending = server.waitForCode({ expectedState: "s", timeoutMs: 5000 });

  const response = await fetch(`http://127.0.0.1:${server.port}/anything-else`);
  assert.equal(response.status, 404);

  // The real callback still works afterwards.
  await fetch(`${server.redirectUri}?code=c&state=s`);
  assert.equal((await pending).code, "c");
});
