import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_RELATIONS_QUERY,
  EXACT_TRIPLE_QUERY,
  relationsBySideQuery,
  type ResolvedStoredRelation,
} from "../src/relations/model.js";
import { mergeStoredRelations } from "../src/relations/merge.js";
import type { Result as QueryResult } from "../src/query/types.js";

const stored = (
  over: Partial<ResolvedStoredRelation> = {},
): ResolvedStoredRelation => ({
  relationUid: "rel1",
  label: "Supports",
  direction: "forward",
  targetUid: "dst1",
  targetTitle: "[[CLM]] - something",
  hasSchema: "schema1",
  ...over,
});

const inferredGroup = (results: Array<Partial<QueryResult>>) => [
  {
    relation: "Supports",
    direction: "forward" as const,
    results: results.map((r) => ({ uid: "dst1", text: "t", ...r })) as QueryResult[],
  },
];

// ── the datalog contract (ADR-019) ────────────────────────────────────────
// These assertions exist because both wrong forms fail *silently* — zero rows,
// no error — which is indistinguishable from an empty graph.

test("props are destructured with keyword get constants, never string keys", () => {
  for (const q of [
    ALL_RELATIONS_QUERY,
    EXACT_TRIPLE_QUERY,
    relationsBySideQuery("source"),
    relationsBySideQuery("destination"),
  ]) {
    assert.match(q, /\(get \?props :discourse-graph\)/);
    assert.doesNotMatch(q, /get \?props "/);
    assert.doesNotMatch(q, /get \?dg "/);
  }
});

test("no query returns a raw props map from :find", () => {
  for (const q of [
    ALL_RELATIONS_QUERY,
    EXACT_TRIPLE_QUERY,
    relationsBySideQuery("source"),
    relationsBySideQuery("destination"),
  ]) {
    const find = /\[:find([^:]*):/.exec(q)?.[1] ?? "";
    assert.doesNotMatch(find, /\?props|\?dg/, `?props escaped into :find of ${q}`);
  }
});

test("relation blocks are matched at any depth on the page, as the plugin does", () => {
  for (const q of [
    ALL_RELATIONS_QUERY,
    EXACT_TRIPLE_QUERY,
    relationsBySideQuery("source"),
    relationsBySideQuery("destination"),
  ]) {
    assert.match(q, /\[\?rel :block\/page \?relPage\]/);
    // :block/children would hide any record that ends up nested, which the
    // extension's own read path still returns.
    assert.doesNotMatch(q, /\?relPage :block\/children/);
  }
});

test("side queries anchor on the requested end and return the far one", () => {
  assert.match(relationsBySideQuery("source"), /\[:find \?relUid \?dst/);
  assert.match(relationsBySideQuery("source"), /\[\(= \?src \?target\)\]/);
  assert.match(relationsBySideQuery("destination"), /\[:find \?relUid \?src/);
  assert.match(relationsBySideQuery("destination"), /\[\(= \?dst \?target\)\]/);
});

// ── merge semantics ───────────────────────────────────────────────────────

test("an edge found both ways is reported once, tagged both", () => {
  const merged = mergeStoredRelations(inferredGroup([{ uid: "dst1" }]), [stored()]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].results.length, 1);
  assert.equal(merged[0].results[0].origin, "both");
  assert.equal(merged[0].results[0].relation_uid, "rel1");
});

test("stored-only edges appear with their relation_uid", () => {
  const merged = mergeStoredRelations([], [stored()]);
  assert.deepEqual(
    merged.map((g) => [g.relation, g.direction, g.results.length]),
    [["Supports", "forward", 1]],
  );
  assert.equal(merged[0].results[0].origin, "stored");
});

test("inferred-only edges keep their origin and have no relation_uid", () => {
  const merged = mergeStoredRelations(inferredGroup([{ uid: "other" }]), []);
  assert.equal(merged[0].results[0].origin, "inferred");
  assert.equal(merged[0].results[0].relation_uid, undefined);
});

test("same label in opposite directions stays in separate groups", () => {
  const merged = mergeStoredRelations(
    [],
    [stored(), stored({ relationUid: "rel2", direction: "complement", targetUid: "src9" })],
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((g) => g.direction).sort(),
    ["complement", "forward"],
  );
});

test("groups left empty are dropped", () => {
  assert.deepEqual(mergeStoredRelations([{ relation: "Supports", direction: "forward", results: [] }], []), []);
});
