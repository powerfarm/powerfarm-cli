import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { CliError } from "../lib/errors.mjs";
import { json, mark, out, relativeTime, style, table } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm ci")} — report and read CI through Antenna's arrangement.

USAGE
  powerfarm ci status [--entity <slug>]
  powerfarm ci report --entity <slug> --check <name> --status passed|failed|... [--sha] [--url]

Reporting is grant-bound (\`ci.report\`). Antenna holds that grant and authenticates
with its Powerfarm service credential — not with its GitHub App private key.
Set POWERFARM_CI_TOKEN to use the service credential from a non-interactive job.
`;

export async function run(argv) {
  const { flags, args } = parse(argv, {
    entity: { type: "string" },
    check: { type: "string" },
    status: { type: "string" },
    sha: { type: "string" },
    url: { type: "string" },
    payload: { type: "string" },
    token: { type: "string" },
  });

  const action = args[0] ?? "status";
  if (!["status", "report"].includes(action)) {
    throw new CliError(`Unknown subcommand \`${action}\`.`, {
      hint: "Try `powerfarm ci status` or `powerfarm ci report`.",
    });
  }

  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  if (action === "status") return status(client, flags);
  return report(client, flags);
}

async function status(client, flags) {
  const query = {
    select: "id,check_name,sha,status,url,reported_at,identities!ci_reports_entity_id_fkey(slug)",
    order: "reported_at.desc",
    limit: "20",
  };
  if (flags.entity) query["identities.slug"] = `eq.${flags.entity}`;

  const rows = await client.rest("ci_reports", query, "list CI reports");
  const list = (rows ?? []).map((row) => ({
    entity: (Array.isArray(row.identities) ? row.identities[0] : row.identities)?.slug ?? "—",
    check: row.check_name,
    status: row.status,
    sha: row.sha ? String(row.sha).slice(0, 8) : "—",
    when: relativeTime(row.reported_at),
  }));

  if (flags.json) return json(list), 0;
  if (list.length === 0) {
    out(style.grey("No CI reports are visible."));
    return 0;
  }
  table(list, [
    ["entity", "ENTITY"],
    ["check", "CHECK"],
    ["status", "STATUS"],
    ["sha", "SHA"],
    ["when", "WHEN"],
  ]);
  return 0;
}

async function report(client, flags) {
  if (!flags.entity || !flags.check || !flags.status) {
    throw new CliError("report needs --entity, --check and --status.");
  }
  let payload = {};
  if (flags.payload) {
    try {
      payload = JSON.parse(flags.payload);
    } catch {
      throw new CliError("--payload must be JSON.");
    }
  }

  const token = flags.token || process.env.POWERFARM_CI_TOKEN || null;
  const row = await client.rpc("powerfarm_report_ci", {
    p_slug: flags.entity,
    p_check_name: flags.check,
    p_status: flags.status,
    p_sha: flags.sha ?? null,
    p_url: flags.url ?? null,
    p_payload: payload,
    p_token: token,
  }, `report CI for ${flags.entity}`);

  if (flags.json) return json(row), 0;
  out(`${mark.ok()} ${flags.entity} ${flags.check} ${row.status}`);
  return 0;
}
