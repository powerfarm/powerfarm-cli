import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
);

export const VERSION = manifest.version;
export const USER_AGENT = `powerfarm-cli/${VERSION} node/${process.versions.node}`;
