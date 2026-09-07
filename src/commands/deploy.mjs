import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { resolvePlaceRef } from "../lib/contracts.mjs";
import { CliError } from "../lib/errors.mjs";
import { facts, json, mark, out, style } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm deploy")} — record a live deployment in the Registry.

USAGE
  powerfarm deploy "<Park>"
  powerfarm deploy <slug> [--machine <slug>] [--environment production]

Examples
  powerfarm deploy "Engine Park 512"
  powerfarm deploy "App Park 8GB"
  powerfarm deploy pf.engine-park.512

A place is bound to its machine. Passing a different --machine is refused.
Deploys only exist in the Registry — nothing outside the books.
`;

export async function run(argv) {
  const { flags, args } = parse(argv, {
    machine: { type: "string" },
    environment: { type: "string", default: "production" },
    revision: { type: "string" },
    url: { type: "string" },
    health: { type: "string" },
    note: { type: "string" },
  });

  const slug = resolvePlaceRef(args);
  if (!slug) {
    throw new CliError("Name the place to deploy.", {
      hint: "Try `powerfarm deploy \"Engine Park 512\"`.",
    });
  }

  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  const row = await client.rpc("powerfarm_record_deployment", {
    p_slug: slug,
    p_environment: flags.environment,
    p_revision: flags.revision ?? null,
    p_url: flags.url ?? null,
    p_machine: flags.machine ?? null,
    p_health: flags.health ?? null,
    p_note: flags.note ?? null,
  }, `deploy ${slug}`);

  if (flags.json) return json(row), 0;

  out(`${mark.ok()} ${style.bold(slug)} ${row.status} on ${flags.environment}`);
  facts([
    ["revision", row.revision ?? style.grey("—")],
    ["url", row.url ?? style.grey("—")],
    ["health", row.health_status ?? style.grey("—")],
    ["id", style.grey(row.id)],
  ]);
  return 0;
}
