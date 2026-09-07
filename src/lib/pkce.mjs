import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createVerifier(random = randomBytes) {
  return random(32).toString("base64url");
}

export function challengeFor(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createState(random = randomBytes) {
  return random(32).toString("base64url");
}

/** Constant-time comparison that never throws on a length mismatch. */
export function safeEqual(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
