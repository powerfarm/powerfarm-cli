import assert from "node:assert/strict";
import test from "node:test";

import {
  KINDS,
  currentVersion,
  metadataViolations,
  normalizeKind,
  resolvePlaceRef,
} from "../src/lib/contracts.mjs";

test("engine is an app qualifier, not a kind", () => {
  assert.equal(KINDS.includes("engine"), false);
  assert.deepEqual(normalizeKind("engine"), { kind: "app", qualifier: "engine" });
  assert.equal(currentVersion("engine"), 2);
  assert.equal(currentVersion("place"), 1);
});

test("place contract requires machine, path and park_type", () => {
  const problems = metadataViolations("place", {
    slug: "pf.engine-park.512",
    title: "Engine Park 512",
    owner: "pf.danvoulez",
  }, 1);
  assert.ok(problems.some((item) => item.includes("machine")));
  assert.ok(problems.some((item) => item.includes("path")));
  assert.ok(problems.some((item) => item.includes("park_type")));
});

test("a well-formed place has no local violations", () => {
  assert.deepEqual(metadataViolations("place", {
    slug: "pf.app-park.8gb",
    title: "App Park 8GB",
    owner: "pf.danvoulez",
    machine: "pf.lab-8gb",
    path: "/Users/ubl-ops/App Park",
    park_type: "app-park",
  }, 1), []);
});

test("app v2 engine qualifier requires park tenant fields", () => {
  const problems = metadataViolations("engine", {
    slug: "pf.pf-engine",
    title: "pf.engine",
    owner: "pf.danvoulez",
    lifecycle: "production",
    runtime: "adk",
    repository: { url: "https://github.com/powerfarm/powerfarm-superbundle" },
    health: { kind: "process" },
    environments: ["production"],
    place: "pf.engine-park.8gb",
    qualifier: "engine",
  }, 2);
  assert.ok(problems.some((item) => item.includes("resources")));
  assert.ok(problems.some((item) => item.includes("capabilities")));
  assert.ok(problems.some((item) => item.includes("bindings")));
});

test("deploy aliases resolve the four parks", () => {
  assert.equal(resolvePlaceRef(["Engine Park 512"]), "pf.engine-park.512");
  assert.equal(resolvePlaceRef(["App Park", "8GB"]), "pf.app-park.8gb");
  assert.equal(resolvePlaceRef(["pf.engine-park.8gb"]), "pf.engine-park.8gb");
  assert.equal(resolvePlaceRef(["app park 512"]), "pf.app-park.512");
});

test("person admission only needs slug and title", () => {
  assert.deepEqual(metadataViolations("person", {
    slug: "pf.danvoulez",
    title: "danvoulez",
  }, 1), []);
});
