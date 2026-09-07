import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import {
  CURRENT_VERSION,
  KINDS,
  currentVersion,
  metadataViolations,
  normalizeKind,
} from "../lib/contracts.mjs";
import { CliError } from "../lib/errors.mjs";
import { facts, json, mark, out, style } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm register")} — admit an entity into the Registry.

USAGE
  powerfarm register <kind> --slug <pf.name> --title <title> [options]
  powerfarm register engine --slug <pf.name> --title <title> --place <park> ...

KINDS
  ${KINDS.join(" | ")}
  engine is an app with qualifier=engine, not a separate kind.

A new app uses contract v${CURRENT_VERSION.app} and must name a place. Existing
v1 apps (Antenna) stay valid. Person, office, machine, workflow, object and
place use v1.

OPTIONS
  --slug              Stable identifier. Never reused.
  --title             Display title
  --name              identities.name (defaults to title)
  --owner             Owning entity slug
  --mandate           Mandate text
  --metadata          JSON object merged over the flags
  --contract-version  Override the current contract for this kind
  --place --qualifier --park-type --machine --path
  --lifecycle --runtime --os --arch --route --brand-version
`;

export async function run(argv) {
  const { flags, args } = parse(argv, {
    slug: { type: "string" },
    title: { type: "string" },
    name: { type: "string" },
    owner: { type: "string" },
    mandate: { type: "string" },
    metadata: { type: "string" },
    "contract-version": { type: "string" },
    place: { type: "string" },
    qualifier: { type: "string" },
    "park-type": { type: "string" },
    machine: { type: "string" },
    path: { type: "string" },
    lifecycle: { type: "string" },
    runtime: { type: "string" },
    os: { type: "string" },
    arch: { type: "string" },
    route: { type: "string" },
    "brand-version": { type: "string" },
    repository: { type: "string" },
    health: { type: "string" },
    environments: { type: "string" },
    capabilities: { type: "string" },
    resources: { type: "string" },
    bindings: { type: "string" },
  });

  const kindArg = args[0];
  if (!kindArg) {
    throw new CliError("Name a kind to register.", {
      hint: `One of: ${KINDS.join(", ")}, or engine.`,
    });
  }

  const { kind, qualifier } = normalizeKind(kindArg);
  if (!KINDS.includes(kind)) {
    throw new CliError(`Unknown kind \`${kindArg}\`.`, {
      hint: `One of: ${KINDS.join(", ")}, or engine.`,
    });
  }

  let extra = {};
  if (flags.metadata) {
    try {
      extra = JSON.parse(flags.metadata);
    } catch {
      throw new CliError("--metadata must be a JSON object.");
    }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
      throw new CliError("--metadata must be a JSON object.");
    }
  }

  const metadata = { ...extra };
  const assign = (key, value, parseJson = false) => {
    if (value === undefined) return;
    if (parseJson) {
      try {
        metadata[key] = JSON.parse(value);
      } catch {
        metadata[key] = value;
      }
      return;
    }
    metadata[key] = value;
  };

  assign("slug", flags.slug);
  assign("title", flags.title);
  assign("owner", flags.owner);
  assign("mandate", flags.mandate);
  assign("place", flags.place);
  assign("qualifier", flags.qualifier ?? qualifier ?? undefined);
  assign("park_type", flags["park-type"]);
  assign("machine", flags.machine);
  assign("path", flags.path);
  assign("lifecycle", flags.lifecycle);
  assign("runtime", flags.runtime);
  assign("os", flags.os);
  assign("arch", flags.arch);
  assign("route", flags.route);
  assign("brand_version", flags["brand-version"]);
  assign("repository", flags.repository, true);
  assign("health", flags.health, true);
  assign("environments", flags.environments, true);
  assign("capabilities", flags.capabilities, true);
  assign("resources", flags.resources, true);
  assign("bindings", flags.bindings, true);

  if (typeof metadata.repository === "string") {
    metadata.repository = { url: metadata.repository };
  }
  if (typeof metadata.health === "string") {
    metadata.health = { path: metadata.health };
  }
  if (typeof metadata.environments === "string") {
    metadata.environments = metadata.environments.split(",").map((item) => item.trim());
  }

  const version = flags["contract-version"]
    ? Number(flags["contract-version"])
    : currentVersion(kindArg);
  if (!Number.isInteger(version) || version < 1) {
    throw new CliError("contract-version must be a positive integer.");
  }

  const problems = metadataViolations(kindArg, metadata, version);
  if (problems.length) {
    throw new CliError(`Contract violated: ${problems.join("; ")}`, {
      hint: "Run `powerfarm register --help` and fill the required fields.",
    });
  }

  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });
  const row = await client.rpc("powerfarm_register_entity", {
    p_kind: kindArg,
    p_name: flags.name ?? metadata.title,
    p_metadata: metadata,
    p_mandate: flags.mandate ?? null,
    p_contract_version: version,
  }, `register ${metadata.slug}`);

  if (flags.json) return json(row), 0;

  out(`${mark.ok()} ${style.bold(row.slug)} admitted as ${row.kind} contract v${row.contract_version}`);
  facts([
    ["name", row.name],
    ["kind", row.kind],
    ["place", metadata.place ?? style.grey("—")],
    ["qualifier", metadata.qualifier ?? style.grey("—")],
  ]);
  return 0;
}
