import { createHash } from "node:crypto";

/**
 * RFC 8785-style canonical JSON: object keys sorted by UTF-16 code unit, no
 * insignificant whitespace. Two machines that serialize the same value this
 * way produce the same bytes, which is what makes a content hash portable.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The definition hash a publish is pinned to.
 *
 * Note: the database only validates the *shape* of this value
 * (`^[0-9a-f]{64}$`) — it never recomputes it. So this function, and not the
 * database, is the definition of what a definition hash means. Change it and
 * every previously published revision becomes unverifiable.
 *
 * It covers exactly the authored source: the files and the capability
 * contract. Draft bookkeeping (revision numbers, timestamps) is excluded, so
 * republishing identical source yields an identical hash.
 */
export function definitionHash(authoredState) {
  return sha256Hex(canonicalize({
    files: authoredState?.files ?? {},
    capabilities: authoredState?.capabilities ?? {},
    version: authoredState?.version ?? null,
  }));
}
