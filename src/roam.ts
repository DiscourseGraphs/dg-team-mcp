import { RoamClient, resolveGraph, getPort } from "@roam-research/roam-tools-local";
import { RoamError } from "@roam-research/roam-tools-core";
import type { TreeNode, RoamPullBlock } from "./types.js";

export const DEFAULT_TREE_DEPTH = 10;

let preferredDatalogAction: "data.fast.q" | "data.backend.q" | undefined;

export async function createClient(graph?: string) {
  const resolved = await resolveGraph(graph);
  const port = await getPort();
  const client = new RoamClient({
    graphName: resolved.name,
    graphType: resolved.type,
    token: resolved.token,
    port,
  });
  return { client, nickname: resolved.nickname };
}

export async function datalogQuery<T = unknown>(
  client: RoamClient,
  query: string,
  ...inputs: unknown[]
): Promise<T[]> {
  if (preferredDatalogAction) {
    const response = await client.call<T[]>(preferredDatalogAction, [
      query,
      ...inputs,
    ]);
    return response.result ?? [];
  }

  try {
    const response = await client.call<T[]>("data.fast.q", [query, ...inputs]);
    preferredDatalogAction = "data.fast.q";
    return response.result ?? [];
  } catch (error) {
    if (
      error instanceof RoamError &&
      error.message.includes("Unknown action")
    ) {
      preferredDatalogAction = "data.backend.q";
      const response = await client.call<T[]>("data.backend.q", [query, ...inputs]);
      return response.result ?? [];
    }
    throw error;
  }
}

const DISCOURSE_CONFIG_PAGE_TITLE = "roam/js/discourse-graph";

// TODO: Sanitize interpolated values when accepting user-provided input.
// Currently safe — all values come from hardcoded constants or Roam's own query results.

export async function getPageUidByTitle(
  client: RoamClient,
  title: string,
): Promise<string | undefined> {
  // data.ai.getPage returns { uid, markdown } — most reliable way to find a page
  type PageResult = { uid?: string; markdown?: string };
  try {
    const response = await client.call<PageResult>("data.ai.getPage", [{ title }]);
    if (response.result?.uid) return response.result.uid;
  } catch {
    // Page doesn't exist or API error
  }
  return undefined;
}

export async function getConfigPageUid(
  client: RoamClient,
): Promise<string | undefined> {
  return getPageUidByTitle(client, DISCOURSE_CONFIG_PAGE_TITLE);
}

function sortAndNormalize(blocks: (RoamPullBlock | null | undefined)[]): TreeNode[] {
  return blocks
    .filter((b): b is RoamPullBlock => b != null)
    .sort(
      (a, b) => (a[":block/order"] ?? 0) - (b[":block/order"] ?? 0),
    )
    .map((node) => ({
      uid: node[":block/uid"] ?? "",
      text: node[":block/string"] ?? node[":node/title"] ?? "",
      children: sortAndNormalize(node[":block/children"] ?? []),
    }));
}

export async function getBasicTreeByParentUid(
  client: RoamClient,
  uid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<TreeNode[]> {
  const result = await getBasicTreeByParentUidWithMeta(client, uid, maxDepth);
  return result.tree;
}

const hasChildren = async (
  client: RoamClient,
  uid: string,
): Promise<boolean> => {
  const rows = await datalogQuery<[string]>(
    client,
    `[:find ?childUid
      :where
      [?parent :block/uid "${uid}"]
      [?parent :block/children ?child]
      [?child :block/uid ?childUid]]`,
  );
  return rows.length > 0;
};

/** One row per block: the block itself plus the uid of its direct parent. */
export type FlatBlock = {
  uid: string;
  text: string;
  order: number;
  parentUid: string;
};

// Every descendant of `uid`, at any depth, in ONE query.
//
// `:block/parents` is Roam's transitive-ancestor attribute, so it matches the
// whole subtree in a single pass; `[?parent :block/children ?b]` then recovers
// each block's *direct* parent so the tree can be reassembled locally. This
// replaces a level-by-level recursion that issued one query per block — 712
// round trips (~10s) for the discourse config page alone, against ~190ms here.
//
// Still simple Datalog with tuple bindings: no pull, no :keys — both silently
// fail via the Local API.
const descendantsQuery = (uid: string) => `[:find ?uid ?text ?order ?parentUid
  :where
  [?root :block/uid "${uid}"]
  [?b :block/parents ?root]
  [?b :block/uid ?uid]
  [?b :block/string ?text]
  [?b :block/order ?order]
  [?parent :block/children ?b]
  [?parent :block/uid ?parentUid]]`;

/**
 * Rebuild a tree from flat (block, parent) rows, walking down from `rootUid`.
 *
 * Blocks whose parent chain does not reach the root are dropped rather than
 * reparented — the same blocks the level-by-level walk never reached, e.g. the
 * children of a block that carries no `:block/string`.
 */
export function assembleTree(
  rows: FlatBlock[],
  rootUid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): { tree: TreeNode[]; truncated: boolean } {
  const byParent = new Map<string, FlatBlock[]>();
  for (const row of rows) {
    if (row == null || row.uid == null || row.text == null) continue;
    const siblings = byParent.get(row.parentUid);
    if (siblings) siblings.push(row);
    else byParent.set(row.parentUid, [row]);
  }
  // Sibling order can be genuinely tied — sandbox-dg has two blocks sharing an
  // :block/order under the same parent. Break by uid so the same graph always
  // comes back in the same order instead of following row order out of Roam.
  for (const siblings of byParent.values()) {
    siblings.sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.uid.localeCompare(b.uid),
    );
  }

  let truncated = false;
  const build = (parentUid: string, depth: number): TreeNode[] => {
    const children = byParent.get(parentUid) ?? [];
    if (depth >= maxDepth) {
      if (children.length) truncated = true;
      return [];
    }
    return children.map((child) => ({
      uid: child.uid,
      text: child.text,
      children: build(child.uid, depth + 1),
    }));
  };

  return { tree: build(rootUid, 0), truncated };
}

export async function getBasicTreeByParentUidWithMeta(
  client: RoamClient,
  uid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<{
  tree: TreeNode[];
  truncated: boolean;
  maxDepth: number;
}> {
  // Nothing to build, and the subtree query would be pure waste — ask the one
  // question a zero-depth caller actually has.
  if (maxDepth <= 0) {
    return { tree: [], truncated: await hasChildren(client, uid), maxDepth };
  }

  const rows = await datalogQuery<[string, string, number, string]>(
    client,
    descendantsQuery(uid),
  );
  const { tree, truncated } = assembleTree(
    rows
      .filter((r) => r != null)
      .map(([blockUid, text, order, parentUid]) => ({
        uid: blockUid,
        text,
        order,
        parentUid,
      })),
    uid,
    maxDepth,
  );

  return { tree, truncated, maxDepth };
}

export async function getPageEditTime(
  client: RoamClient,
  uid: string,
): Promise<number | null> {
  const results = await datalogQuery<[number]>(
    client,
    `[:find ?edit-time :where [?p :block/uid "${uid}"] [?p :edit/time ?edit-time]]`,
  );
  return results[0]?.[0] ?? null;
}

const NODE_PAGE_PREFIX = "discourse-graph/nodes/";

// Every page title in the graph. Deliberately unfiltered: the prefix match
// happens in JS. `clojure.string/starts-with?` does work over the Local API
// (verified on both `data.fast.q` and `data.backend.q`, contradicting the note
// in ARCHITECTURE.md), but the cost of being wrong here is total — a predicate
// that quietly matches nothing makes the graph look unconfigured and silently
// degrades every discourse tool to defaults. A few thousand titles is a cheap
// price for having no predicate to be wrong about.
const ALL_PAGE_TITLES_QUERY = `[:find ?uid ?title
  :where
  [?p :node/title ?title]
  [?p :block/uid ?uid]]`;

// Every block on the given pages, tagged with the page it belongs to, in one
// query. `:block/page` is the direct page pointer (so it doubles as the group
// key); the parent join is what makes the rows reassemblable into trees. The
// page set arrives as a collection binding — also verified on both actions.
const NODE_PAGE_BLOCKS_QUERY = `[:find ?pageUid ?uid ?text ?order ?parentUid
  :in $ [?pageUid ...]
  :where
  [?page :block/uid ?pageUid]
  [?b :block/page ?page]
  [?b :block/uid ?uid]
  [?b :block/string ?text]
  [?b :block/order ?order]
  [?parent :block/children ?b]
  [?parent :block/uid ?parentUid]]`;

export async function getNodePages(
  client: RoamClient,
): Promise<Map<string, { text: string; children: TreeNode[] }>> {
  // Two queries rather than one per page. They stay separate because a node
  // page with no blocks yet still has to appear in the result, and a join on
  // blocks would silently drop it.
  //
  // This used to go through `data.ai.search` and parse the title back out of
  // the returned markdown. That API caps its result page: on dg-team it
  // reported total=27 and returned 20, so seven node types — Hypothesis,
  // Experiment, Milestone, Opportunity, Experience, UserProfile, Initiative —
  // were invisible to every tool. Sandbox has 16 node pages, under the cap,
  // which is why it never showed up in testing.
  const pages = (await datalogQuery<[string, string]>(client, ALL_PAGE_TITLES_QUERY))
    .filter((row) => row?.[0] && row[1]?.startsWith(NODE_PAGE_PREFIX))
    .map(([uid, title]) => ({ uid, text: title.substring(NODE_PAGE_PREFIX.length) }));

  if (!pages.length) return new Map();

  const blocks = await datalogQuery<[string, string, string, number, string]>(
    client,
    NODE_PAGE_BLOCKS_QUERY,
    pages.map((p) => p.uid),
  );

  const blocksByPage = new Map<string, FlatBlock[]>();
  for (const row of blocks) {
    if (row == null) continue;
    const [pageUid, uid, text, order, parentUid] = row;
    const block = { uid, text, order, parentUid };
    const onPage = blocksByPage.get(pageUid);
    if (onPage) onPage.push(block);
    else blocksByPage.set(pageUid, [block]);
  }

  return new Map(
    pages.map(({ uid, text }) => [
      uid,
      { text, children: assembleTree(blocksByPage.get(uid) ?? [], uid).tree },
    ]),
  );
}
