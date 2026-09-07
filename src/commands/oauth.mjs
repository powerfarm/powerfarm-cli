import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { allLoopbackRedirects } from "../lib/config.mjs";
import { CliError } from "../lib/errors.mjs";
import { facts, json, mark, out, relativeTime, style, table } from "../lib/output.mjs";
import { confirm } from "../lib/prompt.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm oauth")} — manage OAuth clients.

USAGE
  powerfarm oauth clients list
  powerfarm oauth clients create --name <name> --redirect <url> [--redirect <url>…]
                                 [--public] [--env production|preview|development]
  powerfarm oauth clients register-cli --name <name>
  powerfarm oauth clients revoke <client-id>

REGISTER-CLI
  Registers a public client carrying every loopback redirect this CLI can bind:
${allLoopbackRedirects().map((uri) => `    ${uri}`).join("\n")}
  This is how you bootstrap ${style.cyan("powerfarm login")} on a fresh project.

Every one of these needs the ${style.bold("oauth.clients.manage")} or
${style.bold("registry.admin")} grant; the Registry refuses otherwise.
`;

export async function run(argv) {
  const { flags, args } = parse(argv, {
    name: { type: "string" },
    redirect: { type: "string", multiple: true },
    public: { type: "boolean", default: false },
    env: { type: "string", default: "production" },
    scope: { type: "string", default: "openid email profile offline_access" },
    uri: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
  });

  const [group, action = "list", target] = args;
  if (group !== "clients") {
    throw new CliError(`Unknown subcommand \`${group ?? ""}\`.`, { hint: "Try `powerfarm oauth clients list`." });
  }

  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  if (action === "list") return list(client, flags);
  if (action === "create") return create(client, flags, {});
  if (action === "register-cli") {
    return create(client, flags, {
      redirect: allLoopbackRedirects(),
      public: true,
      name: flags.name ?? "Powerfarm CLI",
    });
  }
  if (action === "revoke") return revoke(client, target, flags);
  throw new CliError(`Unknown subcommand \`${action}\`.`);
}

async function list(client, flags) {
  const { clients } = await client.registry("/api/oauth/clients", {}, "list OAuth clients");
  if (flags.json) return json(clients), 0;
  if (!clients?.length) {
    out(style.grey("No OAuth clients are registered."));
    return 0;
  }

  table(clients.map((entry) => ({
    id: entry.client_id,
    name: entry.client_name,
    type: entry.token_endpoint_auth_method === "none" ? "public" : "confidential",
    status: entry.registry?.status ?? style.grey("unlinked"),
    created: relativeTime(entry.registry?.created_at ?? entry.created_at),
  })), [["id", "CLIENT ID"], ["name", "NAME"], ["type", "TYPE"],
    ["status", "STATUS"], ["created", "CREATED"]]);
  return 0;
}

async function create(client, flags, preset) {
  const name = preset.name ?? flags.name;
  const redirects = preset.redirect ?? flags.redirect;
  if (!name) throw new CliError("Give the client a name with --name.");
  if (!redirects?.length) {
    throw new CliError("Give at least one redirect URI with --redirect.");
  }

  const isPublic = preset.public ?? flags.public;
  const body = {
    client_name: name,
    client_uri: flags.uri,
    redirect_uris: redirects,
    client_type: isPublic ? "public" : "confidential",
    environment: flags.env,
    scope: flags.scope,
  };

  const created = await client.registry("/api/oauth/clients", { method: "POST", body },
    "create the OAuth client");

  if (flags.json) return json(created), 0;

  out(`${mark.ok()} Registered ${style.bold(name)}`);
  facts([
    ["client id", style.bold(created.client?.client_id ?? "—")],
    ["type", isPublic ? "public (no secret)" : "confidential"],
    ["redirects", redirects.join("\n" + " ".repeat(13))],
    ["registry", created.registry?.linked ? created.registry.status : style.yellow("not linked")],
  ]);

  if (!isPublic && created.client?.client_secret) {
    out();
    out(style.yellow("  This secret is shown once and never again:"));
    out(`  ${style.bold(created.client.client_secret)}`);
  }
  if (preset.redirect) {
    out();
    out("  Point the CLI at it:");
    out(`  ${style.cyan(`export POWERFARM_CLIENT_ID=${created.client?.client_id}`)}`);
  }
  return 0;
}

async function revoke(client, target, flags) {
  if (!target) throw new CliError("Name the client id to revoke.");
  if (!await confirm(`Revoke client ${target}? Sessions issued through it stop refreshing.`,
    { assumeYes: flags.yes })) {
    out(`${mark.info()} Left untouched.`);
    return 0;
  }
  const result = await client.registry(`/api/oauth/clients/${encodeURIComponent(target)}`,
    { method: "DELETE" }, "revoke the OAuth client");
  if (flags.json) return json(result), 0;
  out(`${mark.ok()} Revoked ${style.bold(target)}.`);
  return 0;
}
