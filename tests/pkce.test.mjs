import assert from "node:assert/strict";
import test from "node:test";

import { challengeFor, createState, createVerifier, safeEqual } from "../src/lib/pkce.mjs";
import { canonicalize, definitionHash, sha256Hex } from "../src/lib/canonical.mjs";

test("PKCE challenge matches the RFC 7636 appendix B test vector", () => {
  // If this ever changes, every issuer will reject our exchanges.
  assert.equal(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("verifier and state are 43-character base64url with 256 bits of entropy", () => {
  const verifier = createVerifier();
  const state = createState();
  for (const value of [verifier, state]) {
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.notEqual(createVerifier(), createVerifier());
});

test("safeEqual rejects mismatches without throwing on differing lengths", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("abc", ""), false);
  assert.equal(safeEqual(undefined, "abc"), false);
  assert.equal(safeEqual("abc", null), false);
});

test("canonical JSON sorts keys and ignores insertion order", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalize({ z: [3, { y: 1, x: 2 }], a: null }),
    '{"a":null,"z":[3,{"x":2,"y":1}]}',
  );
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
});

test("definition hash is stable across key order and sensitive to content", () => {
  const one = { version: "0.1.0", files: { "a.yaml": "x", "b.yaml": "y" }, capabilities: { run: {} } };
  const two = { capabilities: { run: {} }, files: { "b.yaml": "y", "a.yaml": "x" }, version: "0.1.0" };
  assert.equal(definitionHash(one), definitionHash(two));
  assert.match(definitionHash(one), /^[0-9a-f]{64}$/);

  // The database validates the shape only, so drift here is silent — pin it.
  const changed = { ...one, files: { ...one.files, "a.yaml": "changed" } };
  assert.notEqual(definitionHash(one), definitionHash(changed));

  // Draft bookkeeping must not leak into the hash, or republishing identical
  // source would produce a different revision.
  assert.equal(definitionHash({ ...one, draft_revision: 7 }), definitionHash(one));
});

test("sha256Hex is hex and stable", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
