/**
 * Mirrors contracts/registry.json in powerfarm-registry.
 * Engine is an app qualifier, not a kind. `register engine` rewrites to app.
 */
export const KINDS = ["person", "office", "app", "agent", "machine", "workflow", "object", "place"];

export const CURRENT_VERSION = {
  person: 1,
  office: 1,
  app: 2,
  agent: 1,
  machine: 1,
  workflow: 1,
  object: 1,
  place: 1,
};

export const REQUIRED = {
  person: { 1: ["slug", "title"] },
  office: { 1: ["slug", "title", "mandate"] },
  app: {
    1: ["slug", "title", "owner", "lifecycle", "runtime", "repository", "health", "environments"],
    2: ["slug", "title", "owner", "lifecycle", "runtime", "repository", "health", "environments", "place", "qualifier"],
  },
  agent: { 1: ["slug", "title", "owner", "lifecycle", "mandate", "capabilities"] },
  machine: { 1: ["slug", "title", "owner", "lifecycle", "os", "arch"] },
  workflow: { 1: ["slug", "title", "owner", "lifecycle", "trigger", "steps"] },
  object: { 1: ["slug", "title", "owner", "qualifier"] },
  place: { 1: ["slug", "title", "owner", "machine", "path", "park_type"] },
};

export const PARK_TYPES = ["engine-park", "app-park"];

export const QUALIFIERS = {
  app: { placeParkType: "app-park", requires: ["route", "brand_version"] },
  engine: { placeParkType: "engine-park", requires: ["resources", "capabilities", "bindings"] },
};

const SLUG_RE = /^pf(\.[a-z0-9][a-z0-9-]*)+$/;

export function isSlug(value) {
  return typeof value === "string" && SLUG_RE.test(value);
}

export function normalizeKind(kind) {
  if (kind === "engine") return { kind: "app", qualifier: "engine" };
  return { kind, qualifier: null };
}

export function requiredKeys(kind, version) {
  const { kind: resolved } = normalizeKind(kind);
  return REQUIRED[resolved]?.[String(version)] ?? REQUIRED[resolved]?.[version] ?? null;
}

export function currentVersion(kind) {
  const { kind: resolved } = normalizeKind(kind);
  return CURRENT_VERSION[resolved] ?? null;
}

/**
 * Shape-check metadata the same way the database will. Referential checks
 * (owner exists, place is a place) stay on the server.
 */
export function metadataViolations(kind, metadata, version) {
  const resolved = normalizeKind(kind);
  const effectiveKind = resolved.kind;
  const keys = requiredKeys(effectiveKind, version);
  if (!keys) return [`unknown kind or contract version: ${kind} v${version}`];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["metadata must be a JSON object"];
  }

  const problems = [];
  const meta = { ...metadata };
  if (resolved.qualifier && !meta.qualifier) meta.qualifier = resolved.qualifier;

  for (const key of keys) {
    if (meta[key] === undefined || meta[key] === null) {
      problems.push(`missing required field: ${key}`);
    }
  }
  if (meta.slug && !isSlug(meta.slug)) problems.push("slug must match pf.<name>");
  if (meta.owner && !isSlug(meta.owner)) problems.push("owner must be an entity slug");
  if (typeof meta.title === "string" && meta.title.length < 2) {
    problems.push("title must be at least 2 characters");
  }

  if (effectiveKind === "place") {
    if (meta.machine && !isSlug(meta.machine)) problems.push("machine must be an entity slug");
    if (typeof meta.path === "string" && !meta.path.startsWith("/")) {
      problems.push("path must be an absolute path");
    }
    if (meta.park_type && !PARK_TYPES.includes(meta.park_type)) {
      problems.push("park_type must be engine-park or app-park");
    }
  }

  if (effectiveKind === "app" && version >= 2) {
    const qualifier = meta.qualifier ?? resolved.qualifier;
    if (qualifier && !QUALIFIERS[qualifier]) {
      problems.push("qualifier must be app or engine");
    } else if (qualifier) {
      for (const field of QUALIFIERS[qualifier].requires) {
        if (meta[field] === undefined || meta[field] === null) {
          problems.push(`missing required field: ${field}`);
        }
      }
    }
    if (meta.place && !isSlug(meta.place)) problems.push("place must be an entity slug");
  }

  return problems;
}

const PLACE_ALIASES = {
  "engine park 512": "pf.engine-park.512",
  "app park 512": "pf.app-park.512",
  "engine park 8gb": "pf.engine-park.8gb",
  "engine park 8 gb": "pf.engine-park.8gb",
  "app park 8gb": "pf.app-park.8gb",
  "app park 8 gb": "pf.app-park.8gb",
};

export function resolvePlaceRef(tokens) {
  const joined = tokens.filter(Boolean).join(" ").trim();
  if (!joined) return null;
  if (isSlug(joined)) return joined;
  const key = joined.toLowerCase().replace(/\s+/g, " ");
  if (PLACE_ALIASES[key]) return PLACE_ALIASES[key];
  const compact = key.replace(/\s+/g, "");
  for (const [alias, slug] of Object.entries(PLACE_ALIASES)) {
    if (alias.replace(/\s+/g, "") === compact) return slug;
  }
  return joined;
}
