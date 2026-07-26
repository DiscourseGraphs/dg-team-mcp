// Smoke-test the stored-relation read + write path through the real MCP server
// over stdio, with DG_MCP_RELATION_WRITE enabled.
// Run: npx tsx scripts/relations-smoke.ts [graph]
//
// Fixtures are from sandbox-dg. Any relation this script creates is deleted
// again at the end, via a direct client (the MCP intentionally exposes no
// relation-delete tool).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RoamClient, resolveGraph, getPort } from "@roam-research/roam-tools-local";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deleteStoredRelation } from "../src/relations/write.js";

const graph = process.argv[2] ?? "sandbox-dg";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// sandbox-dg fixtures
const NODE_WITH_STORED_RELATION = "rEFoCX_Fd"; // source of stored "Addresses" wu-6iya5a
const SUPPORTS_SOURCE = "fviMW2nIY"; // [[RES]] ...
const SUPPORTS_DEST = "sQOmkO4Be"; // [[HYP]] ...

const transport = new StdioClientTransport({
  command: "node",
  args: [join(root, "dist/index.js")],
  env: { ...process.env, DG_MCP_RELATION_WRITE: "1" } as Record<string, string>,
});
const client = new Client({ name: "relations-smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (!cond) failures += 1;
  console.log(
    `${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : ` :: ${JSON.stringify(detail)?.slice(0, 400)}`}`,
  );
};
const textOf = (res: { content: unknown }) =>
  (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
const call = async (name: string, args: Record<string, unknown>) =>
  textOf(await client.callTool({ name, arguments: { graph, ...args } }));
// Guidelines are prepended to responses, and error responses are plain prose,
// so parse leniently and fall back to the raw text.
const json = (text: string): Record<string, unknown> => {
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      /* not JSON — fall through */
    }
  }
  return { __text: text };
};

const tools = (await client.listTools()).tools.map((t) => t.name);
check("create_discourse_relation registered under DG_MCP_RELATION_WRITE", tools.includes("create_discourse_relation"), tools);

// ── READ: the regression this branch exists to fix ────────────────────────
const readOut = json(await call("get_relationships", { uid: NODE_WITH_STORED_RELATION }));
const storedHits = (readOut.relations ?? []).flatMap((g: { results: { origin: string }[] }) =>
  g.results.filter((r) => r.origin === "stored" || r.origin === "both"),
);
check(
  `get_relationships surfaces stored relations for ${NODE_WITH_STORED_RELATION} (was 0 before this branch)`,
  storedHits.length > 0,
  readOut,
);
check("stored results carry a relation_uid", storedHits.every((r: { relation_uid?: string }) => !!r.relation_uid), storedHits);
check("response reports stale-schema records rather than hiding them", typeof readOut.stale_schema_records === "number", readOut);

// ── WRITE: validation before mutation ─────────────────────────────────────
const selfRel = await call("create_discourse_relation", {
  source_uid: SUPPORTS_SOURCE, destination_uid: SUPPORTS_SOURCE, relation: "Supports",
});
check("refuses to relate a node to itself", /itself/i.test(selfRel), selfRel);

const bogusNode = await call("create_discourse_relation", {
  source_uid: "zzzzzzzzz", destination_uid: SUPPORTS_DEST, relation: "Supports",
});
check("rejects a uid that does not exist", /No such uid/i.test(bogusNode), bogusNode);

const bogusLabel = await call("create_discourse_relation", {
  source_uid: SUPPORTS_SOURCE, destination_uid: SUPPORTS_DEST, relation: "Fnord",
});
check("rejects an unknown relation label", /No relation labelled/i.test(bogusLabel), bogusLabel);

// ── WRITE: dry run, then real write, then dedup ───────────────────────────
const dry = await call("create_discourse_relation", {
  source_uid: SUPPORTS_SOURCE, destination_uid: SUPPORTS_DEST, relation: "Supports", dry_run: true,
});
const ambiguous = /ambiguous/i.test(dry);
console.log(ambiguous ? "note: 'Supports' is ambiguous here (expected — grammar defines it twice)" : "note: 'Supports' resolved uniquely");
// If ambiguous, take the first suggested schema uid and pin it. Extract by
// regex, not JSON.parse — the graph guidelines are prepended to every response
// and contain brackets of their own.
const pinned = ambiguous
  ? /"relation_schema_uid":\s*"([^"]+)"/.exec(dry)?.[1]
  : undefined;
if (ambiguous) console.log(`  pinning relation_schema_uid=${pinned}`);
const writeArgs = {
  source_uid: SUPPORTS_SOURCE,
  destination_uid: SUPPORTS_DEST,
  relation: "Supports",
  ...(pinned ? { relation_schema_uid: pinned } : {}),
};
check("ambiguity is refused with actionable schema uids, not guessed", !ambiguous || !!pinned, dry);

const dry2 = json(await call("create_discourse_relation", { ...writeArgs, dry_run: true }));
check("dry_run resolves without writing", dry2.created === false && dry2.reason === "dry_run", dry2);

const created = json(await call("create_discourse_relation", writeArgs));
check("relation created", created.created === true && !!created.relation_uid, created);

const again = json(await call("create_discourse_relation", writeArgs));
check("second identical create is a no-op, not a duplicate", again.created === false && again.reason === "already_exists" && again.relation_uid === created.relation_uid, again);

// Round-trip: the new relation must be visible to the read path.
const roundTrip = json(await call("get_relationships", { uid: SUPPORTS_SOURCE }));
const sawIt = (roundTrip.relations ?? []).some((g: { results: { relation_uid?: string }[] }) =>
  g.results.some((r) => r.relation_uid === created.relation_uid),
);
check("newly written relation is readable back through get_relationships", sawIt, roundTrip);

// ── cleanup ───────────────────────────────────────────────────────────────
if (created.relation_uid) {
  const resolved = await resolveGraph(graph);
  const direct = new RoamClient({
    graphName: resolved.name, graphType: resolved.type, token: resolved.token, port: await getPort(),
  });
  await deleteStoredRelation(direct, created.relation_uid);
  console.log(`cleaned up ${created.relation_uid}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
await client.close();
process.exit(failures ? 1 : 0);
