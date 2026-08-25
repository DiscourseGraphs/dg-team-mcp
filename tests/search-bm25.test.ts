import assert from "node:assert/strict";
import test from "node:test";
import type { RoamClient } from "@roam-research/roam-tools-local";
import { handleSearchNodes, rankTitlesBM25 } from "../src/tools/search-nodes.js";

const doc = (text: string, uid = text, created = 0) => ({
  text,
  uid,
  created,
  author: "Test User",
});

// ── rankTitlesBM25 ────────────────────────────────────────────────────────

test("partial matches are returned — all query words are no longer required", () => {
  const ranked = rankTitlesBM25(
    [doc("Membrane tension regulates assembly")],
    "membrane tension endocytosis",
  );
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].score > 0);
});

test("titles matching more query words rank higher", () => {
  const ranked = rankTitlesBM25(
    [
      doc("Actin dynamics in cells"),
      doc("Actin assembly at endocytosis sites"),
      doc("Microtubule transport"),
    ],
    "actin endocytosis",
  );
  assert.deepEqual(
    ranked.map((r) => r.text),
    ["Actin assembly at endocytosis sites", "Actin dynamics in cells"],
  );
});

test("titles containing no query word are excluded", () => {
  const ranked = rankTitlesBM25([doc("Microtubule transport")], "actin");
  assert.deepEqual(ranked, []);
});

test("rarer query words count for more than common ones (IDF)", () => {
  const ranked = rankTitlesBM25(
    [
      doc("model of transport"),
      doc("model of endocytosis"),
      doc("model of migration"),
      doc("kinetics of endocytosis"),
    ],
    "model endocytosis",
  );
  const texts = ranked.map((r) => r.text);
  // "endocytosis" (df=2) is rarer than "model" (df=3), so the
  // endocytosis-only title outranks the model-only titles.
  assert.ok(
    texts.indexOf("kinetics of endocytosis") < texts.indexOf("model of transport"),
  );
});

test("shorter titles rank higher when term counts tie (length normalization)", () => {
  const ranked = rankTitlesBM25(
    [doc("Actin assembly dynamics in migrating cells"), doc("Actin")],
    "actin",
  );
  assert.deepEqual(
    ranked.map((r) => r.text),
    ["Actin", "Actin assembly dynamics in migrating cells"],
  );
});

test("query words still match inside longer words, as the old substring filter did", () => {
  const ranked = rankTitlesBM25([doc("Endocytosis review")], "endocyto");
  assert.equal(ranked.length, 1);
});

test("empty query returns no results", () => {
  assert.deepEqual(rankTitlesBM25([doc("Actin")], "   "), []);
});

test("equal scores break by created date, newest first", () => {
  const ranked = rankTitlesBM25(
    [doc("actin ring", "old-uid", 100), doc("actin ring", "new-uid", 200)],
    "actin",
  );
  assert.deepEqual(
    ranked.map((r) => r.uid),
    ["new-uid", "old-uid"],
  );
});

// ── handleSearchNodes (stubbed transport) ─────────────────────────────────

type Row = [string, string, number, string];
const stubClient = (rows: Row[]): RoamClient =>
  ({ call: async () => ({ result: rows }) }) as unknown as RoamClient;

const row = (title: string, uid = title, created = 0): Row => [
  title,
  uid,
  created,
  "Test User",
];

test("handleSearchNodes returns BM25-ranked results with scores", async () => {
  const client = stubClient([
    row("Actin dynamics in cells"),
    row("Actin assembly at endocytosis sites"),
    row("Microtubule transport"),
  ]);
  const response = await handleSearchNodes(client, "actin endocytosis");
  const parsed = JSON.parse(response.content[0].text);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.results[0].text, "Actin assembly at endocytosis sites");
  assert.equal(typeof parsed.results[0].score, "number");
});

test("handleSearchNodes respects the limit after ranking", async () => {
  const client = stubClient([
    row("actin one"),
    row("actin two"),
    row("actin three"),
  ]);
  const response = await handleSearchNodes(client, "actin", undefined, 2);
  const parsed = JSON.parse(response.content[0].text);
  assert.equal(parsed.count, 2);
});
