import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { definitionHash } from "../lib/canonical.mjs";
import { CliError } from "../lib/errors.mjs";
import { facts, json, mark, out, relativeTime, style, table } from "../lib/output.mjs";
import { confirm } from "../lib/prompt.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `
${style.bold("powerfarm gadget")} — author, publish and install Gadgets.

USAGE
  powerfarm gadget list
  powerfarm gadget show <id>
  powerfarm gadget pull <id> [--dir <path>]
  powerfarm gadget push <id> [--dir <path>]
  powerfarm gadget publish <id>
  powerfarm gadget install <id> --workspace <slug> [--revision <n>] [--auto-update]
  powerfarm gadget uninstall <id> --workspace <slug>

THE LINEAGE
  pull    Write the draft's authored files into a local directory.
  push    Send changed files back as one patch. The server bumps the draft
          revision and recomputes the content hash; a stale base revision
          comes back as ${style.yellow("revision_conflict")} and nothing is written.
  publish Freeze the current draft into an immutable revision. Requires a
          non-empty capability contract, and pins the definition hash.
`;

export async function run(argv) {
  const { flags, args } = parse(argv, {
    dir: { type: "string" },
    workspace: { type: "string", short: "w" },
    revision: { type: "string" },
    "auto-update": { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    message: { type: "string", short: "m" },
  });
  const [action, id] = args;
  if (!action) throw new CliError("Name a subcommand.", { hint: "Try `powerfarm gadget list`." });

  const session = await requireSession({ profile: flags.profile });
  const client = createClient({ endpoints: session.endpoints, accessToken: session.accessToken });

  const actions = { list, show, pull, push, publish, install, uninstall };
  const handler = actions[action];
  if (!handler) throw new CliError(`Unknown subcommand \`${action}\`.`);
  return handler(client, id, flags);
}

async function list(client, _id, flags) {
  const gadgets = await client.rest("gadgets", {
    select: "id,title,current_revision,updated_at,workspaces!inner(slug)",
    order: "updated_at.desc",
  }, "list gadgets");

  const rows = gadgets.map((gadget) => ({
    id: gadget.id,
    title: gadget.title,
    workspace: (Array.isArray(gadget.workspaces) ? gadget.workspaces[0] : gadget.workspaces)?.slug ?? "—",
    revision: gadget.current_revision ?? style.grey("unpublished"),
    updated: relativeTime(gadget.updated_at),
  }));

  if (flags.json) return json(rows), 0;
  if (rows.length === 0) {
    out(style.grey("No gadgets are visible to your identity."));
    return 0;
  }
  table(rows, [["id", "ID"], ["title", "TITLE"], ["workspace", "WORKSPACE"],
    ["revision", "REV"], ["updated", "UPDATED"]]);
  return 0;
}

async function readDraft(client, id) {
  if (!id) throw new CliError("Name the gadget.");
  const draft = await client.rpc("powerfarm_gadget_get_draft", { p_gadget_id: id },
    `read the draft for ${id}`);
  if (!draft) {
    throw new CliError(`No draft for ${style.bold(id)}.`, {
      hint: "Either the gadget does not exist or RLS is hiding it from you.",
    });
  }
  return draft;
}

async function show(client, id, flags) {
  const draft = await readDraft(client, id);
  const revisions = await client.rest("gadget_revisions", {
    select: "revision,version,content_hash,definition_hash,published_at",
    gadget_id: `eq.${id}`,
    order: "revision.desc",
    limit: "5",
  }, "list revisions").catch(() => []);

  if (flags.json) return json({ draft, revisions }), 0;

  facts([
    ["gadget", style.bold(draft.gadget_id)],
    ["draft rev", String(draft.draft_revision)],
    ["published", draft.published_revision === null
      ? style.yellow("never")
      : String(draft.published_revision)],
    ["content", style.grey(draft.content_hash ?? "—")],
    ["updated", relativeTime(draft.updated_at)],
    ["files", Object.keys(draft.authored_state?.files ?? {}).length
      ? Object.keys(draft.authored_state.files).join(", ")
      : style.yellow("none")],
    ["capabilities", Object.keys(draft.authored_state?.capabilities ?? {}).length
      ? Object.keys(draft.authored_state.capabilities).join(", ")
      : style.yellow("none — publish will be refused")],
  ]);

  if (revisions.length) {
    out();
    out(style.grey("REVISIONS"));
    table(revisions.map((revision) => ({
      revision: revision.revision,
      version: revision.version,
      published: relativeTime(revision.published_at),
      definition: (revision.definition_hash ?? "").slice(0, 12),
    })), [["revision", "REV"], ["version", "VERSION"], ["published", "PUBLISHED"],
      ["definition", "DEFINITION"]]);
  }
  return 0;
}

const targetDir = (id, flags) => flags.dir ?? join(process.cwd(), id);

async function pull(client, id, flags) {
  const draft = await readDraft(client, id);
  const files = draft.authored_state?.files ?? {};
  const names = Object.keys(files);
  if (names.length === 0) throw new CliError(`Draft ${id} has no files to pull.`);

  const dir = targetDir(id, flags);
  for (const name of names) {
    const path = safeJoin(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(files[name]), "utf8");
  }
  // Record the base revision so `push` can detect a stale working copy.
  await writeFile(join(dir, ".powerfarm.json"),
    `${JSON.stringify({ gadget: id, baseRevision: draft.draft_revision,
      contentHash: draft.content_hash, pulledAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8");

  if (flags.json) return json({ dir, files: names, baseRevision: draft.draft_revision }), 0;
  out(`${mark.ok()} Pulled ${names.length} file${names.length === 1 ? "" : "s"} at revision ${draft.draft_revision}`);
  out(`  ${style.grey(dir)}`);
  return 0;
}

async function push(client, id, flags) {
  const dir = targetDir(id, flags);
  const local = await collectFiles(dir);
  if (Object.keys(local).length === 0) throw new CliError(`No files found under ${dir}.`);

  const draft = await readDraft(client, id);
  const remote = draft.authored_state?.files ?? {};
  const changed = Object.fromEntries(
    Object.entries(local).filter(([name, content]) => remote[name] !== content));
  const removed = Object.keys(remote).filter((name) => !(name in local));

  if (Object.keys(changed).length === 0 && removed.length === 0) {
    out(`${mark.info()} Nothing to push — the draft already matches ${style.grey(dir)}.`);
    return 0;
  }

  // apply_patch merges shallowly (authored_state || patch), so the whole files
  // object is replaced. That is what makes deletions expressible at all.
  const patch = { files: local };
  const operationId = randomUUID();

  const updated = await client.rpc("powerfarm_gadget_apply_patch", {
    p_gadget_id: id,
    p_base_revision: draft.draft_revision,
    p_patch: patch,
    p_client_operation_id: operationId,
  }, `push changes to ${id}`);

  if (flags.json) return json(updated), 0;
  out(`${mark.ok()} Draft is now at revision ${style.bold(updated.draft_revision)}`);
  for (const name of Object.keys(changed)) out(`  ${style.green("~")} ${name}`);
  for (const name of removed) out(`  ${style.red("-")} ${name}`);
  return 0;
}

async function publish(client, id, flags) {
  const draft = await readDraft(client, id);
  const capabilities = draft.authored_state?.capabilities ?? {};
  if (Object.keys(capabilities).length === 0) {
    throw new CliError("This draft declares no capabilities.", {
      hint: "publish requires a non-empty capability contract (capability_contract_required).",
    });
  }

  const hash = definitionHash(draft.authored_state);
  if (!flags.yes && !flags.json) {
    out(`About to publish ${style.bold(id)} at draft revision ${draft.draft_revision}.`);
    out(`  ${style.grey(`definition hash ${hash}`)}`);
    if (!await confirm("Publish?", { assumeYes: flags.yes })) {
      out(`${mark.info()} Cancelled.`);
      return 0;
    }
  }

  const revision = await client.rpc("powerfarm_gadget_publish", {
    p_gadget_id: id,
    p_base_revision: draft.draft_revision,
    p_definition_hash: hash,
  }, `publish ${id}`);

  if (flags.json) return json(revision), 0;
  out(`${mark.ok()} Published revision ${style.bold(revision.revision)} (${revision.version})`);
  out(`  ${style.grey(`content ${revision.content_hash}`)}`);
  return 0;
}

async function install(client, id, flags) {
  if (!id) throw new CliError("Name the gadget to install.");
  if (!flags.workspace) throw new CliError("Name the workspace with --workspace.");

  const [workspace] = await client.rest("workspaces", {
    select: "id,slug", slug: `eq.${flags.workspace}`,
  }, "find the workspace");
  if (!workspace) throw new CliError(`No workspace ${style.bold(flags.workspace)} is visible to you.`);

  let revision = flags.revision ? Number(flags.revision) : null;
  if (revision === null) {
    const [gadget] = await client.rest("gadgets", {
      select: "current_revision", id: `eq.${id}`,
    }, "read the gadget");
    revision = gadget?.current_revision ?? null;
    if (!revision) {
      throw new CliError(`${id} has no published revision to install.`, {
        hint: "Run `powerfarm gadget publish` first.",
      });
    }
  }

  let installed;
  try {
    installed = await client.upsert("gadget_installations", {
      workspace_id: workspace.id,
      gadget_id: id,
      revision,
      status: "installed",
      auto_update: flags["auto-update"],
    }, { onConflict: "workspace_id,gadget_id" }, `install ${id}`);
  } catch (error) {
    error.hint ??= "Installation is governed by RLS; you need owner or editor on the workspace.";
    throw error;
  }

  if (flags.json) return json(installed), 0;
  out(`${mark.ok()} Installed ${style.bold(id)} revision ${revision} into ${flags.workspace}`);
  if (flags["auto-update"]) out(`  ${style.grey("auto-update on: new revisions roll forward automatically")}`);
  return 0;
}

async function uninstall(client, id, flags) {
  if (!id) throw new CliError("Name the gadget to uninstall.");
  if (!flags.workspace) throw new CliError("Name the workspace with --workspace.");
  const [workspace] = await client.rest("workspaces", {
    select: "id", slug: `eq.${flags.workspace}`,
  }, "find the workspace");
  if (!workspace) throw new CliError(`No workspace ${style.bold(flags.workspace)} is visible to you.`);

  const removed = await client.patch("gadget_installations", {
    workspace_id: `eq.${workspace.id}`,
    gadget_id: `eq.${id}`,
  }, { status: "removed" }, `uninstall ${id}`);

  if (!removed) throw new CliError(`${style.bold(id)} is not installed in ${flags.workspace}.`);
  if (flags.json) return json(removed), 0;
  out(`${mark.ok()} Removed ${style.bold(id)} from ${flags.workspace}`);
  return 0;
}

/** Walk a directory into a { relativePath: contents } map, skipping metadata. */
async function collectFiles(dir, root = dir, into = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new CliError(`${dir} does not exist.`, { hint: "Run `powerfarm gadget pull` first." });
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(path, root, into);
    else into[relative(root, path).split(sep).join("/")] = await readFile(path, "utf8");
  }
  return into;
}

/** Refuse a path from the server that would escape the target directory. */
function safeJoin(dir, name) {
  const path = join(dir, name);
  if (!path.startsWith(dir + sep) && path !== dir) {
    throw new CliError(`Refusing to write outside the target directory: ${name}`);
  }
  return path;
}
