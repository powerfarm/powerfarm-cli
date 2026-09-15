import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "../lib/api.mjs";
import { parse } from "../lib/args.mjs";
import { CliError } from "../lib/errors.mjs";
import { json } from "../lib/output.mjs";
import { requireSession } from "../lib/session.mjs";

export const help = `powerfarm service — versioned templates and two levels of Antenna contracts.

  service templates
  service publish --file template.json --artifact pf.service.name --version 1 --repo org/repo --commit SHA --path contracts/template.json
  service create NAME --template pf.service.name@1 --provider pf.antenna --client pf.service.name --until ISO_DATE [--max-bytes 65536] [--destinations '["https://host/path"]']
  service client NAME --service PARENT --client pf.app --until ISO_DATE [--max-bytes 65536] [--destinations '[]']
  service accept NAME --sha256 HASH --party pf.identity
  service revoke NAME --sha256 HASH
  service list
  service inspect NAME
  service credential --entity pf.identity --label LABEL --out PRIVATE_FILE
  service invoke NAME --file input.json [--url https://antenna.minilab.work]
  service result NAME --receipt RECEIPT_ID [--url https://antenna.minilab.work]

Management uses your existing Registry login and registry.admin grant.
Accept records the exact hash, represented party and actual operator.
Invoke reads ANTENNA_CLIENT_TOKEN_FILE; credentials are never printed.
The credential output file must not already exist.
`;

export async function run(argv) {
  const { flags, args } = parse(argv, Object.fromEntries([
    "file","artifact","version","repo","commit","path","template","provider","client","until",
    "max-bytes","destinations","service","sha256","party","entity","label","out","url","receipt",
  ].map(k => [k,{type:"string"}])));
  const [action, name] = args;
  if (action === "invoke" || action === "result") {
    if (!name || !(action === "invoke" ? flags.file : flags.receipt)) throw new CliError("Name a contract and --file or --receipt.");
    const tokenFile = process.env.ANTENNA_CLIENT_TOKEN_FILE ?? join(homedir(),".config","antenna-contracts","antenna-client.token");
    const token = (await readFile(tokenFile,"utf8")).trim();
    const url = new URL(flags.url ?? "https://antenna.minilab.work/");
    if (url.protocol!=="https:" && !(url.protocol==="http:" && ["localhost","127.0.0.1"].includes(url.hostname))) throw new CliError("Use HTTPS or loopback HTTP.");
    const args = action === "invoke" ? {contract:name,input:JSON.parse(await readFile(flags.file,"utf8"))} : {contract:name,receipt_id:flags.receipt};
    const body = {jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"invoke_service",arguments:args,_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}};
    const response = await fetch(url, {method:"POST",redirect:"error",headers:{"User-Agent":"powerfarm-antenna-cli/0.1","Content-Type":"application/json","Mcp-Protocol-Version":"2026-07-28","Mcp-Method":"tools/call","Mcp-Name":"invoke_service","Authorization":`Bearer ${token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});
    const result = await response.json();
    if (!response.ok || result.error || result.result?.isError) throw new CliError(`Antenna rejected invocation (HTTP ${response.status}): ${result.error?.message ?? JSON.stringify(result.result?.structuredContent) ?? "see receipt"}`);
    json(result); return 0;
  }
  const session = await requireSession({profile:flags.profile});
  const client = createClient(session);
  async function identity(slug) {
    if (!slug) throw new CliError("An identity slug is required.");
    const rows = await client.rest("identities",{slug:`eq.${slug}`,select:"id,slug",limit:"1"});
    if (!rows?.[0]) throw new CliError(`Unknown registered identity: ${slug}`);
    return rows[0].id;
  }
  if (action === "templates") { json(await client.rest("service_definitions")); return 0; }
  if (action === "list" || action === "inspect") {
    const rows = await client.rest("service_contracts",action === "inspect" ? {name:`eq.${name}`} : {});
    const events = action === "inspect" && rows?.[0] ? await client.rest("service_contract_events",{contract_id:`eq.${rows[0].id}`,order:"id.asc"}) : undefined;
    json(events ? {contract:rows[0],events} : rows); return 0;
  }
  if (action === "credential") {
    if (!flags.entity || !flags.label || !flags.out) throw new CliError("--entity, --label and --out are required.");
    // Reserve the private file before issuing a credential; never overwrite one.
    await writeFile(flags.out,"",{flag:"wx",mode:0o600});
    const credential = await client.rpc("powerfarm_issue_service_credential",{p_slug:flags.entity,p_label:flags.label});
    await writeFile(flags.out,`${credential.token}\n`,{mode:0o600});
    json({id:credential.id,identity:credential.identity,path:flags.out}); return 0;
  }
  let operation = action, document;
  if (action === "publish") {
    if (!flags.file || !flags.artifact || !flags.version) throw new CliError("--file, --artifact and --version are required.");
    const source = await readFile(flags.file,"utf8");
    document = {source,artifact_id:flags.artifact,version:flags.version,source_repo:flags.repo,source_commit:flags.commit,source_path:flags.path,sha256:createHash("sha256").update(source).digest("hex")};
  } else if (action === "create" || action === "client") {
    if (!name || !flags.until) throw new CliError("Name and --until are required.");
    let destinations;
    try { destinations = JSON.parse(flags.destinations ?? "[]"); } catch { throw new CliError("--destinations must be a JSON array."); }
    const maxBytes = Number(flags["max-bytes"] ?? 65536);
    document = {name,kind:action === "create" ? "service" : "client",client_id:await identity(flags.client),valid_until:flags.until,terms:{max_bytes:maxBytes,destinations}};
    if (action === "create") {
      const split = flags.template?.lastIndexOf("@");
      if (split === undefined || split<1) throw new CliError("--template must be artifact@version.");
      Object.assign(document,{provider_id:await identity(flags.provider),artifact_id:flags.template.slice(0,split),version:flags.template.slice(split+1)});
    } else { if (!flags.service) throw new CliError("--service is required."); document.parent = flags.service; }
    operation = "propose";
  } else if (action === "accept" || action === "revoke") {
    if (!name || !flags.sha256) throw new CliError("Name and --sha256 are required.");
    document = {name,sha256:flags.sha256};
    if (action === "accept") document.party_id = await identity(flags.party);
  } else throw new CliError("Unknown service command.",{hint:help});
  json(await client.rpc("powerfarm_service_command",{p_operation:operation,p_document:document}));
  return 0;
}
