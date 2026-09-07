import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir, configPath, credentialsPath } from "./config.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

/**
 * Write atomically and privately: create the temp file inside the same
 * directory so the rename cannot cross a filesystem, and chmod before the
 * rename so the secret is never briefly world-readable.
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const temp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  await chmod(temp, FILE_MODE);
  await rename(temp, path);
}

export async function readConfig() {
  return readJson(configPath(), { defaultProfile: "default", profiles: {} });
}

export async function writeConfig(config) {
  await writeJson(configPath(), config);
}

export async function readCredentials() {
  return readJson(credentialsPath(), { profiles: {} });
}

export async function getCredential(profile) {
  const store = await readCredentials();
  return store.profiles?.[profile] ?? null;
}

export async function saveCredential(profile, credential) {
  const store = await readCredentials();
  store.profiles = { ...store.profiles, [profile]: credential };
  await writeJson(credentialsPath(), store);
}

export async function clearCredential(profile) {
  const store = await readCredentials();
  if (!store.profiles?.[profile]) return false;
  delete store.profiles[profile];
  await writeJson(credentialsPath(), store);
  return true;
}

export async function clearAllCredentials() {
  try {
    await unlink(credentialsPath());
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function credentialLocation() {
  return { dir: configDir(), config: configPath(), credentials: credentialsPath() };
}
