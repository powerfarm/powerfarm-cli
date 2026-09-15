import { CliError } from "./errors.mjs";

/**
 * Two backends, deliberately:
 *
 *  - PostgREST (`rest`/`rpc`) for anything RLS already governs. The CLI sends
 *    the user's own bearer token, so the database enforces authority and the
 *    CLI gets no privilege the browser does not have.
 *  - The Registry API (`registry`) only where a server-side secret is
 *    unavoidable — creating OAuth clients through the provider admin API.
 */
export function createClient({ endpoints, accessToken }) {
  const restHeaders = () => ({
    apikey: endpoints.publishableKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  });

  /**
   * Turn a response into data, or into an error that says what actually
   * happened. Two rules matter here:
   *
   *  - 401 and 403 are different failures. A rejected token is fixed by
   *    signing in again; a refused row is fixed by grants. Reporting both as
   *    "not authorized … check your grants" sends you down the wrong path.
   *  - A body that is not JSON is never data. Returning the text verbatim let
   *    an HTML sign-in page reach callers as a successful payload, where
   *    destructuring it yielded `undefined` and the CLI reported an empty
   *    result instead of a failure.
   */
  async function unwrap(response, what, { expectJson = true } = {}) {
    const text = await response.text();
    let payload = null;
    let isJson = true;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
        isJson = false;
      }
    }

    const detail = isJson
      ? payload?.message || payload?.error_description || payload?.error || payload?.hint || payload?.msg || null
      : null;

    if (response.status === 401) {
      throw new CliError(
        `Not authorized to ${what}: the access token was rejected${detail ? ` (${detail})` : ""}.`,
        { hint: "The session may have expired. Run `powerfarm login` to sign in again.", code: 4 },
      );
    }
    if (response.status === 403) {
      throw new CliError(`Refused to ${what}${detail ? `: ${detail}` : ""}.`, {
        hint: "Your grants may not cover this action. Check `powerfarm status`.",
        code: 4,
      });
    }
    if (!response.ok) {
      throw new CliError(`Could not ${what}: ${detail ?? `HTTP ${response.status}`}`);
    }
    if (expectJson && !isJson) {
      const kind = /^\s*<(?:!doctype|html)/i.test(text) ? "an HTML page" : "a non-JSON body";
      throw new CliError(`Could not ${what}: the server returned ${kind}, not JSON.`, {
        hint: "The endpoint may be behind a browser session guard that ignores bearer tokens.",
        code: 4,
      });
    }
    return payload;
  }

  return {
    endpoints,

    /** Read a table through PostgREST. `query` is a plain object of params. */
    async rest(table, query = {}, what = `read ${table}`) {
      const url = new URL(`${endpoints.apiUrl}/rest/v1/${table}`);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
      }
      return unwrap(await fetch(url, { headers: restHeaders() }), what);
    },

    /**
     * Insert or update a row. `onConflict` names the unique constraint that
     * turns this into an upsert; without it a duplicate is an error.
     */
    async upsert(table, row, { onConflict } = {}, what = `write to ${table}`) {
      const url = new URL(`${endpoints.apiUrl}/rest/v1/${table}`);
      if (onConflict) url.searchParams.set("on_conflict", onConflict);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...restHeaders(),
          Prefer: `${onConflict ? "resolution=merge-duplicates," : ""}return=representation`,
        },
        body: JSON.stringify(row),
      });
      const payload = await unwrap(response, what);
      return Array.isArray(payload) ? payload[0] : payload;
    },

    /** Update rows matching `filter` (a plain object of PostgREST predicates). */
    async patch(table, filter, changes, what = `update ${table}`) {
      const url = new URL(`${endpoints.apiUrl}/rest/v1/${table}`);
      for (const [key, value] of Object.entries(filter)) url.searchParams.set(key, value);
      const response = await fetch(url, {
        method: "PATCH",
        headers: { ...restHeaders(), Prefer: "return=representation" },
        body: JSON.stringify(changes),
      });
      const payload = await unwrap(response, what);
      return Array.isArray(payload) ? payload[0] : payload;
    },

    /** Call a Postgres function. */
    async rpc(name, args = {}, what = `call ${name}`) {
      const response = await fetch(`${endpoints.apiUrl}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: restHeaders(),
        body: JSON.stringify(args),
      });
      return unwrap(response, what);
    },

    /**
     * Call the Registry's own API with the same bearer token.
     *
     * An API endpoint has no reason to redirect. When it does, it is a browser
     * session guard bouncing an unauthenticated request to a sign-in page --
     * which answers 200 with HTML and would otherwise be mistaken for data.
     */
    async registry(path, { method = "GET", body } = {}, what = `reach the registry`) {
      const url = `${endpoints.registryUrl}${path}`;
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.redirected) {
        throw new CliError(
          `Could not ${what}: the registry redirected to ${response.url} instead of answering.`,
          {
            hint: "The registry did not accept the bearer token and sent the request to a browser sign-in page.",
            code: 4,
          },
        );
      }
      return unwrap(response, what);
    },
  };
}

/** The caller's identity, grants and default workspace in one round trip each. */
export async function whoAmI(client) {
  const [links, grants, workspaces] = await Promise.all([
    client.rest("identity_links", {
      select: "identity_id,linked_at,identities!inner(id,name,kind,mandate)",
      unlinked_at: "is.null",
    }, "read your identity link"),
    client.rest("grants", {
      select: "action,resource,valid_until",
      revoked_at: "is.null",
    }, "read your grants"),
    client.rest("workspaces", { select: "id,slug,title", limit: "10" }, "read your workspaces"),
  ]);
  const link = links?.[0] ?? null;
  const identity = Array.isArray(link?.identities) ? link.identities[0] : link?.identities;
  return {
    identity: identity ?? null,
    linkedAt: link?.linked_at ?? null,
    grants: (grants ?? []).map((grant) => grant.action),
    workspaces: workspaces ?? [],
  };
}
