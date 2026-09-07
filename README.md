# powerfarm

The Powerfarm command line.

Zero runtime dependencies. Node 20.11 or newer.

## Install

Not published to npm yet, so from a clone of this repo:

```sh
npm run cli:link          # puts `powerfarm` and `pf` on your PATH
powerfarm login
```

`npm run cli:link` is `npm link --workspace powerfarm`. To undo it later,
`npm unlink -g powerfarm`.

Without linking, run it straight out of the repo — no install, no PATH change:

```sh
npm run cli -- login
npm run cli -- status
node packages/cli/bin/powerfarm.mjs doctor
```

Once it is published, the usual `npx powerfarm@latest login` will work.

## Getting started

```sh
powerfarm login        # browser sign-in via loopback + PKCE
powerfarm status       # session, endpoints, grants
powerfarm doctor       # find out why something is broken
```

## Authentication

The CLI is a **public OAuth client**. It ships no client secret and never
stores one — PKCE is what protects the exchange. There are three ways in.

| Mode | Use it when | How |
| --- | --- | --- |
| Browser | Normal interactive use | `powerfarm login` |
| Pasted token | SSH, remote boxes, no browser | `powerfarm login --token` |
| Environment | CI | `export POWERFARM_TOKEN=…` |

`POWERFARM_TOKEN` is used in memory and never written to disk. The other two
modes write `~/.config/powerfarm/credentials.json` with mode `0600`.

### Why loopback and not a device code

The issuer advertises `authorization_code` and `refresh_token` only — there is
no device authorization grant — so the `gh auth login` pattern is unavailable.
The CLI binds `127.0.0.1` on one of four fixed ports, sends you to Identity,
and catches the redirect:

```
http://127.0.0.1:51789/callback
http://127.0.0.1:51790/callback
http://127.0.0.1:51791/callback
http://127.0.0.1:51792/callback
```

All four are registered on the client because Supabase matches `redirect_uris`
exactly rather than ignoring the port as RFC 8252 §7.3 suggests. The port is
bound *before* the authorization URL is built, so the signed `redirect_uri` is
always one the CLI can actually receive on.

## Bootstrapping a project

A fresh project has no CLI client. Register one with an account that holds
`oauth.clients.manage`:

```sh
powerfarm oauth clients register-cli --name "Powerfarm CLI"
export POWERFARM_CLIENT_ID=<the id it prints>
```

This requires the loopback carve-out in `lib/oauth-admin.mjs`: a public client
may use literal `127.0.0.1` redirects in any environment. `localhost` stays
development-only, because it resolves through DNS (RFC 8252 §8.3).

## Profiles

A profile pins a set of endpoints; anything it does not pin falls back to the
environment, then to the production defaults.

```sh
powerfarm profile set staging --api-url https://staging.supabase.co
powerfarm login --profile staging
powerfarm profile use staging
```

## Commands

```
login       Authenticate this machine
logout      Discard stored credentials
whoami      Show the signed-in identity
status      Show session, endpoints and grants
doctor      Diagnose a broken setup
profile     Manage named profiles
gadget      Author, publish and install Gadgets
oauth       Manage OAuth clients
runs        Inspect runs
workspace   Inspect workspaces
```

Every command takes `--json` for scripting, and `--profile <name>`.

## The Gadget lineage

```sh
powerfarm gadget pull hello-agentic       # draft → local files
powerfarm gadget push hello-agentic       # local files → one patch
powerfarm gadget publish hello-agentic    # freeze an immutable revision
powerfarm gadget install hello-agentic -w danvoulez
```

`pull` records the base revision in `.powerfarm.json`. `push` sends the whole
`files` object as one patch, so deletions are expressible; the server bumps the
draft revision and recomputes the content hash. A stale base comes back as
`revision_conflict` and nothing is written.

`publish` requires a non-empty capability contract and pins a definition hash.

> **Note on the definition hash.** The database validates only its shape
> (`^[0-9a-f]{64}$`) — it never recomputes it. So `src/lib/canonical.mjs`, not
> the database, is the definition of what a definition hash means. It covers
> the authored files, the capability contract and the version, canonicalized
> per RFC 8785. Changing that function makes every previously published
> revision unverifiable.

## Authority

The CLI holds no privilege the browser does not. Reads and writes go through
PostgREST with your own bearer token, so RLS decides everything. The single
exception is creating and revoking OAuth clients, which needs the provider
admin API and therefore goes through the Registry, gated on
`oauth.clients.manage` or `registry.admin` first.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Command failed |
| `2` | Unknown command or bad usage |
| `3` | Network unreachable |
| `4` | Not authenticated, or refused for lack of a grant |
