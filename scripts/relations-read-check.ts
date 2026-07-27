// Read-only validation of the stored-relation read path against any graph.
// Makes NO writes. Run: npx tsx scripts/relations-read-check.ts [graph]
import { dedupeRelations, getInternalDiscourseConfig } from "../src/discourse-config.js";
import { getAllStoredRelations, getStoredRelationsForNode } from "../src/relations/read.js";
import { createClient } from "../src/roam.js";

const graph = process.argv[2] ?? "dg-team";
const { client, nickname } = await createClient(graph);

const cfg = await getInternalDiscourseConfig(client);
const relations = dedupeRelations(cfg.relations);
console.log(`graph=${nickname}  node types=${cfg.nodes.length}  relation defs=${relations.length} (raw ${cfg.relations.length})`);

const all = await getAllStoredRelations(client);
console.log(`stored relation records: ${all.length}`);

const known = new Set(relations.map((x) => x.id));
const dangling = all.filter((x) => !known.has(x.hasSchema));
console.log(`dangling hasSchema: ${dangling.length} across ${new Set(dangling.map((d) => d.hasSchema)).size} missing schema uid(s)`);

const seen = new Map<string, number>();
for (const x of all) {
  const k = `${x.sourceUid}|${x.destinationUid}|${x.hasSchema}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
const dupes = [...seen.values()].filter((n) => n > 1).length;
console.log(`exact-duplicate triples: ${dupes}`);

// Resolve the busiest node through the real read path.
const degree = new Map<string, number>();
for (const x of all) {
  degree.set(x.sourceUid, (degree.get(x.sourceUid) ?? 0) + 1);
  degree.set(x.destinationUid, (degree.get(x.destinationUid) ?? 0) + 1);
}
const [busiest, deg] = [...degree.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
if (busiest) {
  const t0 = process.hrtime.bigint();
  const out = await getStoredRelationsForNode(client, busiest, relations);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`busiest node ${busiest} (degree ${deg}): resolved ${out.relations.length} relations, ${out.staleSchemaCount} stale, in ${ms.toFixed(0)}ms`);
  console.log("labels:", JSON.stringify([...new Set(out.relations.map((x) => `${x.label}/${x.direction}`))]));
  console.log("sample:", JSON.stringify(out.relations.slice(0, 2), null, 1));
}
