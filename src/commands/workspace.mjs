import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { CliError } from "../lib/errors.mjs";
import { json, out, relativeTime, style, table } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm workspace")} — inspect workspaces.

USAGE
  powerfarm workspace list
  powerfarm workspace show <slug-or-id>

Your role is resolved through powerfarm_workspace_role, so what you see here
is exactly what the database will let you do.
`;

export async function run(argv) {
  const { flags, args } = parse(argv);
  const [action = "list", target] = args;
  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  if (action === "list") return list(client, flags);
  if (action === "show") return show(client, target, flags);
  throw new CliError(`Unknown subcommand \`${action}\`.`, { hint: "Try `list` or `show`." });
}

async function list(client, flags) {
  const workspaces = await client.rest("workspaces", {
    select: "id,slug,title,created_at",
    order: "created_at.asc",
  }, "list workspaces");

  const roles = await Promise.all(workspaces.map((workspace) =>
    client.rpc("powerfarm_workspace_role", { p_workspace_id: workspace.id })
      .catch(() => null)));

  const rows = workspaces.map((workspace, index) => ({
    slug: workspace.slug,
    title: workspace.title,
    role: roles[index] ?? "—",
    created: relativeTime(workspace.created_at),
    id: workspace.id,
  }));

  if (flags.json) {
    json(rows);
    return 0;
  }
  if (rows.length === 0) {
    out(style.grey("No workspaces are visible to your identity."));
    return 0;
  }
  table(rows, [["slug", "SLUG"], ["title", "TITLE"], ["role", "ROLE"], ["created", "CREATED"]]);
  return 0;
}

async function show(client, target, flags) {
  if (!target) throw new CliError("Name the workspace to show.");
  const key = /^[0-9a-f-]{36}$/i.test(target) ? "id" : "slug";
  const [workspace] = await client.rest("workspaces", {
    select: "id,slug,title,created_at",
    [key]: `eq.${target}`,
  }, "read the workspace");
  if (!workspace) throw new CliError(`No workspace ${style.bold(target)} is visible to you.`);

  const [role, members, installs] = await Promise.all([
    client.rpc("powerfarm_workspace_role", { p_workspace_id: workspace.id }).catch(() => null),
    client.rest("workspace_members", {
      select: "role,created_at,identities!inner(name,kind)",
      workspace_id: `eq.${workspace.id}`,
    }, "list members").catch(() => []),
    client.rest("gadget_installations", {
      select: "gadget_id,revision,status,auto_update",
      workspace_id: `eq.${workspace.id}`,
    }, "list installations").catch(() => []),
  ]);

  if (flags.json) {
    json({ ...workspace, role, members, installations: installs });
    return 0;
  }

  out(`${style.bold(workspace.title)} ${style.grey(workspace.slug)}`);
  out(style.grey(`  id ${workspace.id} · your role: ${role ?? "none"}`));
  out();
  out(style.grey("MEMBERS"));
  table(members.map((member) => ({
    name: (Array.isArray(member.identities) ? member.identities[0] : member.identities)?.name,
    role: member.role,
    since: relativeTime(member.created_at),
  })), [["name", "NAME"], ["role", "ROLE"], ["since", "SINCE"]]);
  out();
  out(style.grey("INSTALLED GADGETS"));
  if (installs.length === 0) out(style.grey("  none"));
  else {
    table(installs.map((install) => ({
      gadget: install.gadget_id,
      revision: install.revision,
      status: install.status,
      auto: install.auto_update ? "yes" : "no",
    })), [["gadget", "GADGET"], ["revision", "REV"], ["status", "STATUS"], ["auto", "AUTO-UPDATE"]]);
  }
  return 0;
}
