import { createServer } from "node:http";
import { LOOPBACK_PATH, LOOPBACK_PORTS, loopbackRedirect } from "./config.mjs";
import { CliError } from "./errors.mjs";
import { safeEqual } from "./pkce.mjs";

const PAGE = (title, message, tone) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Powerfarm</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
         background:#0f0e0c; color:#f4efe6; }
  main { max-width:26rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; color:${tone}; }
  p { margin:0; opacity:.75; }
</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

const SUCCESS = PAGE("Signed in.", "You can close this tab and return to your terminal.", "#7dd3a0");
const FAILURE = PAGE("Authorization failed.", "Return to your terminal for the details.", "#f0857d");

/**
 * Bind a loopback port *before* the authorization URL is built, so the
 * redirect_uri that gets signed into the request is always one we can actually
 * receive on. Binding afterwards would race a port that just got taken.
 *
 * Only 127.0.0.1 is bound — never 0.0.0.0 — so nothing on the network can
 * reach the callback.
 */
export async function startCallbackServer({ ports = LOOPBACK_PORTS } = {}) {
  const { server, port } = await bindFirstFree(ports);
  const redirectUri = loopbackRedirect(port);

  return {
    port,
    redirectUri,
    close: () => { server.close(); server.closeAllConnections?.(); },

    /** Resolve once the browser returns a code that matches `expectedState`. */
    waitForCode({ expectedState, timeoutMs = 5 * 60_000 }) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          finish();
          reject(new CliError("Timed out waiting for the browser to complete sign-in.", {
            hint: "Run `powerfarm login --token` if this machine cannot open a browser.",
          }));
        }, timeoutMs);

        function finish() {
          clearTimeout(timer);
          server.close();
          // close() only stops new connections; fetch keeps sockets alive, so
          // without this the port stays bound and the process will not exit.
          server.closeAllConnections?.();
        }

        server.on("request", (request, response) => {
          const url = new URL(request.url, `http://127.0.0.1:${port}`);
          if (url.pathname !== LOOPBACK_PATH) {
            response.writeHead(404, { Connection: "close" }).end();
            return;
          }

          const fail = (message) => {
            response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" }).end(FAILURE);
            finish();
            reject(new CliError(message));
          };

          const error = url.searchParams.get("error");
          if (error) {
            const description = url.searchParams.get("error_description");
            return fail(`The identity server returned "${error}"${description ? `: ${description}` : ""}.`);
          }

          // State is checked before the code is even read.
          if (!safeEqual(expectedState, url.searchParams.get("state") ?? "")) {
            return fail("The sign-in response did not match this request (state mismatch).");
          }

          const code = url.searchParams.get("code");
          if (!code) return fail("The identity server returned no authorization code.");

          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" }).end(SUCCESS);
          finish();
          resolve({ code, port, redirectUri });
        });

        server.on("error", (cause) => {
          finish();
          reject(new CliError(`The local callback server failed: ${cause.message}`));
        });
      });
    },
  };
}

/** Probe the loopback ports without keeping any of them. Used by `doctor`. */
export async function probePorts(ports = LOOPBACK_PORTS) {
  const results = [];
  for (const port of ports) {
    try {
      const server = await bind(port);
      server.close();
      results.push({ port, free: true });
    } catch (cause) {
      results.push({ port, free: false, reason: cause.code ?? cause.message });
    }
  }
  return results;
}

async function bindFirstFree(ports) {
  const failures = [];
  for (const port of ports) {
    try {
      return { server: await bind(port), port };
    } catch (cause) {
      failures.push(`${port} (${cause.code ?? cause.message})`);
    }
  }
  throw new CliError(`Could not bind a loopback port. Tried: ${failures.join(", ")}.`, {
    hint: "Close whatever is holding those ports, or use `powerfarm login --token`.",
  });
}

function bind(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error) => {
      server.removeListener("listening", onListening);
      server.close();
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
