import assert from "node:assert/strict";
import test from "node:test";
import type { RoamClient } from "@roam-research/roam-tools-local";
import {
  assembleTree,
  getBasicTreeByParentUidWithMeta,
  getNodePages,
  type FlatBlock,
} from "../src/roam.js";

const block = (
  uid: string,
  parentUid: string,
  order = 0,
  text = uid,
): FlatBlock => ({ uid, text, order, parentUid });

// ── assembleTree ──────────────────────────────────────────────────────────

test("children are ordered by :block/order, not by row order", () => {
  const { tree } = assembleTree(
    [block("c", "root", 2), block("a", "root", 0), block("b", "root", 1)],
    "root",
  );
  assert.deepEqual(tree.map((n) => n.uid), ["a", "b", "c"]);
});

test("a tied :block/order breaks by uid, so output is stable", () => {
  const rows = [block("zzz", "root", 1), block("aaa", "root", 1)];
  assert.deepEqual(assembleTree(rows, "root").tree.map((n) => n.uid), ["aaa", "zzz"]);
  // reversed input, same answer — this is the tie that made two runs disagree
  assert.deepEqual(assembleTree([...rows].reverse(), "root").tree.map((n) => n.uid), ["aaa", "zzz"]);
});

test("nesting is rebuilt from parent links at any depth", () => {
  const { tree, truncated } = assembleTree(
    [block("kid", "root"), block("grandkid", "kid"), block("greatgrandkid", "grandkid")],
    "root",
  );
  assert.equal(truncated, false);
  assert.equal(tree[0].children[0].children[0].uid, "greatgrandkid");
});

test("maxDepth cuts the tree and reports truncation", () => {
  const rows = [block("kid", "root"), block("grandkid", "kid")];
  const shallow = assembleTree(rows, "root", 1);
  assert.deepEqual(shallow.tree.map((n) => n.uid), ["kid"]);
  assert.deepEqual(shallow.tree[0].children, []);
  assert.equal(shallow.truncated, true);

  const deep = assembleTree(rows, "root", 2);
  assert.equal(deep.tree[0].children[0].uid, "grandkid");
  assert.equal(deep.truncated, false);
});

test("maxDepth 0 yields nothing, and says so when children exist", () => {
  assert.deepEqual(assembleTree([block("kid", "root")], "root", 0), {
    tree: [],
    truncated: true,
  });
  assert.deepEqual(assembleTree([], "root", 0), { tree: [], truncated: false });
});

test("blocks that do not descend from the root are dropped, not reparented", () => {
  // `orphan` hangs off a block that carries no :block/string, so it never
  // appears in the rows — the level-by-level walk never reached it either.
  const { tree } = assembleTree(
    [block("kid", "root"), block("orphan", "missing-parent")],
    "root",
  );
  assert.deepEqual(tree.map((n) => n.uid), ["kid"]);
});

// ── round trips ───────────────────────────────────────────────────────────
// The bug this file exists to prevent is a re-introduced N+1: the old code
// issued one query per block (712 for the config page alone, ~10s), which is
// invisible in output and only shows up as latency.

const fakeClient = (rowsFor: (query: string) => unknown[]) => {
  const queries: string[] = [];
  const client = {
    call: async (action: string, args: unknown[]) => {
      assert.equal(action, "data.fast.q", `unexpected action ${action}`);
      const query = String(args[0]);
      queries.push(query);
      return { result: rowsFor(query) };
    },
  } as unknown as RoamClient;
  return { client, queries };
};

test("a whole subtree costs exactly one query", async () => {
  const { client, queries } = fakeClient(() => [
    ["kid", "kid text", 0, "root"],
    ["grandkid", "grandkid text", 0, "kid"],
  ]);

  const { tree, truncated } = await getBasicTreeByParentUidWithMeta(client, "root");

  assert.equal(queries.length, 1, "one query for the entire subtree");
  assert.match(queries[0], /\[\?b :block\/parents \?root\]/);
  assert.equal(tree[0].children[0].text, "grandkid text");
  assert.equal(truncated, false);
});

test("node pages cost two queries regardless of how many pages there are", async () => {
  const { client, queries } = fakeClient((query) =>
    query.includes("?pageUid")
      ? [
          ["p1", "b1", "format", 0, "p1"],
          ["p2", "b2", "format", 0, "p2"],
        ]
      : [
          ["p1", "discourse-graph/nodes/Claim"],
          ["p2", "discourse-graph/nodes/Evidence"],
          ["p3", "discourse-graph/nodes/Empty"],
          ["p4", "some other page"],
        ],
  );

  const pages = await getNodePages(client);

  assert.equal(queries.length, 2, "one page-list query plus one block query");
  assert.deepEqual([...pages.keys()], ["p1", "p2", "p3"]);
  assert.equal(pages.get("p1")?.text, "Claim");
  assert.equal(pages.get("p1")?.children[0].text, "format");
  // A node page with no blocks yet must still be returned — joining pages to
  // blocks in a single query would silently drop it.
  assert.deepEqual(pages.get("p3"), { text: "Empty", children: [] });
});

test("the page list is filtered in JS, with no datalog string predicate", async () => {
  const { client, queries } = fakeClient((query) =>
    query.includes("?pageUid") ? [] : [["p1", "discourse-graph/nodes/Claim"]],
  );

  await getNodePages(client);

  // A predicate that quietly matches nothing would read as "graph not
  // configured" and degrade every discourse tool to defaults.
  assert.doesNotMatch(queries[0], /clojure\.string|re-find|re-pattern/);
  assert.match(queries[0], /\[\?p :node\/title \?title\]/);
});

test("no node pages means no second query", async () => {
  const { client, queries } = fakeClient(() => [["p1", "not a node page"]]);

  assert.equal((await getNodePages(client)).size, 0);
  assert.equal(queries.length, 1);
});
