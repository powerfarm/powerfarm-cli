import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { CliError } from "../lib/errors.mjs";
import { facts, json, out, relativeTime, style, table } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm runs")} — inspect runs.

USAGE
  powerfarm runs list [--gadget <id>] [--status <state>] [--limit <n>]
  powerfarm runs show <run-id>
  powerfarm runs grants [--gadget <id>]

Runs are readable only where RLS allows it — in practice, runs you created.
`;

const STATUS_COLOR = {
  succeeded: style.green,
  failed: style.red,
  running: style.cyan,
  pending: style.yellow,
};

export async function run(argv) {
  const { flags, args } = parse(argv, {
    gadget: { type: "string", short: "g" },
    status: { type: "string", short: "s" },
    limit: { type: "string", short: "n" },
  });
  const [action = "list", target] = args;
  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  if (action === "list") return list(client, flags);
  if (action === "show") return show(client, target, flags);
  if (action === "grants") return grants(client, flags);
  throw new CliError(`Unknown subcommand \`${action}\`.`, {
    hint: "Try `list`, `show` or `grants`.",
  });
}

async function list(client, flags) {
  const query = {
    select: "id,gadget_id,gadget_version,intent,status,started_at,ended_at,capability_ref,operation",
    order: "started_at.desc",
    limit: flags.limit ?? "20",
  };
  if (flags.gadget) query.gadget_id = `eq.${flags.gadget}`;
  if (flags.status) query.status = `eq.${flags.status}`;

  const runs = await client.rest("runs", query, "list runs");
  if (flags.json) return json(runs), 0;
  if (runs.length === 0) {
    out(style.grey("No runs are visible to your identity."));
    return 0;
  }

  table(runs.map((entry) => ({
    id: entry.id.slice(0, 8),
    gadget: entry.gadget_id ?? "—",
    capability: entry.capability_ref ?? "—",
    status: (STATUS_COLOR[entry.status] ?? style.grey)(entry.status),
    started: relativeTime(entry.started_at),
  })), [["id", "ID"], ["gadget", "GADGET"], ["capability", "CAPABILITY"],
    ["status", "STATUS"], ["started", "STARTED"]]);
  return 0;
}

async function show(client, target, flags) {
  if (!target) throw new CliError("Name the run to show.");
  const detail = await client.rpc("powerfarm_run_get", { p_run_id: target },
    `read run ${target}`);
  if (!detail) throw new CliError(`No run ${style.bold(target)} is visible to you.`);
  if (flags.json) return json(detail), 0;

  facts([
    ["run", style.bold(detail.id ?? target)],
    ["gadget", `${detail.gadget_id ?? "—"} ${style.grey(detail.gadget_version ?? "")}`],
    ["capability", detail.capability_ref ?? "—"],
    ["operation", detail.operation ?? "—"],
    ["status", (STATUS_COLOR[detail.status] ?? style.grey)(detail.status ?? "—")],
    ["started", relativeTime(detail.started_at)],
    ["ended", detail.ended_at ? relativeTime(detail.ended_at) : style.grey("—")],
    ["intent", detail.intent ?? style.grey("—")],
  ]);

  if (detail.error) {
    out();
    out(style.red("ERROR"));
    out(`  ${JSON.stringify(detail.error, null, 2).split("\n").join("\n  ")}`);
  }
  if (detail.result) {
    out();
    out(style.grey("RESULT"));
    out(`  ${JSON.stringify(detail.result, null, 2).split("\n").join("\n  ")}`);
  }
  return 0;
}

async function grants(client, flags) {
  const query = {
    select: "id,capability_ref,gadget_ref,gadget_revision,operation,issued_at,expires_at,revoked_at",
    order: "issued_at.desc",
    limit: flags.limit ?? "20",
  };
  if (flags.gadget) query.gadget_ref = `eq.${flags.gadget}`;

  const rows = await client.rest("run_grants", query, "list run grants");
  if (flags.json) return json(rows), 0;
  if (rows.length === 0) {
    out(style.grey("No run grants are visible to your identity."));
    return 0;
  }

  table(rows.map((grant) => ({
    id: grant.id.slice(0, 8),
    gadget: `${grant.gadget_ref}@${grant.gadget_revision}`,
    capability: grant.capability_ref,
    operation: grant.operation,
    state: grant.revoked_at
      ? style.red("revoked")
      : new Date(grant.expires_at) < new Date()
        ? style.grey("expired")
        : style.green("active"),
    expires: relativeTime(grant.expires_at),
  })), [["id", "ID"], ["gadget", "GADGET"], ["capability", "CAPABILITY"],
    ["operation", "OP"], ["state", "STATE"], ["expires", "EXPIRES"]]);
  return 0;
}
