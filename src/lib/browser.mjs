import { spawn } from "node:child_process";

/**
 * Open a URL in the user's browser. Returns false when there is nothing to
 * open into (CI, SSH, a bare container) so the caller can fall back to
 * printing the URL instead of hanging on a browser that will never appear.
 */
export function canOpenBrowser() {
  if (process.env.POWERFARM_NO_BROWSER) return false;
  if (process.env.CI) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

export function openBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
