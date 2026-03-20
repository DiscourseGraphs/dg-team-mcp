import { RoamClient, resolveGraph, getPort, RoamError } from "@roam-research/roam-tools-core";
import type { TreeNode, RoamPullBlock } from "./types.js";

export const DEFAULT_TREE_DEPTH = 10;

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
  // TODO: Determine which Datalog action the Roam Local API supports.
  // data.fast.q is synchronous/in-memory, data.backend.q is async/server-side.
  // Try fast.q first; if unsupported, fall back. Once confirmed, remove fallback.
  try {
    const response = await client.call<T[]>("data.fast.q", [query, ...inputs]);
    return response.result ?? [];
  } catch (error) {
    if (
      error instanceof RoamError &&
      error.message.includes("Unknown action")
    ) {
      const response = await client.call<T[]>("data.backend.q", [query, ...inputs]);
      return response.result ?? [];
    }
    throw error;
  }
}

const DISCOURSE_CONFIG_PAGE_TITLE = "roam/js/discourse-graph";

// TODO: Sanitize interpolated values when accepting user-provided input.
// Currently safe — all values come from hardcoded constants or Roam's own query results.

async function getPageUidByTitle(
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

export async function getBasicTreeByParentUidWithMeta(
  client: RoamClient,
  uid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<{
  tree: TreeNode[];
  truncated: boolean;
  maxDepth: number;
}> {
  // Use simple Datalog with tuple bindings (no pull, no :keys — both silently fail via Local API).
  // Recursively fetch children level by level.
  if (maxDepth <= 0) {
    return {
      tree: [],
      truncated: await hasChildren(client, uid),
      maxDepth,
    };
  }

  const children = await datalogQuery<[string, string, number]>(
    client,
    `[:find ?text ?uid ?order
      :where
      [?parent :block/uid "${uid}"]
      [?parent :block/children ?child]
      [?child :block/string ?text]
      [?child :block/uid ?uid]
      [?child :block/order ?order]]`,
  );

  const sorted = children
    .filter((c) => c != null && c[0] != null)
    .map(([text, uid, order]) => ({ text, uid, order }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Recursively fetch children for each block
  const nodes = await Promise.all(
    sorted.map(async (child) => {
      const subtree = await getBasicTreeByParentUidWithMeta(
        client,
        child.uid,
        maxDepth - 1,
      );
      return {
        uid: child.uid,
        text: child.text,
        children: subtree.tree,
        truncated: subtree.truncated,
      };
    }),
  );

  return {
    tree: nodes.map(({ truncated: _truncated, ...node }) => node),
    truncated: nodes.some((node) => node.truncated),
    maxDepth,
  };
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

export async function getNodePages(
  client: RoamClient,
): Promise<Map<string, { text: string; children: TreeNode[] }>> {
  // Use Roam's search API (data.ai.search) instead of Datalog.
  // Response format: { total, results: [{ uid, markdown, type? }] }
  type SearchResponse = {
    total: number;
    results: Array<{ uid: string; markdown: string; type?: string }>;
  };
  const response = await client.call<SearchResponse>("data.ai.search", [
    { query: "discourse-graph/nodes/", scope: "pages" },
  ]);
  const searchResults = response.result?.results ?? [];

  // Extract title from markdown: "# discourse-graph/nodes/Claim <roam uid=...>"
  const titleFromMarkdown = (md: string): string => {
    const match = md.match(/^#\s+(.+?)(?:\s*<roam|$)/);
    return match?.[1] ?? "";
  };

  const pages = searchResults
    .filter((r) => r != null && r.uid)
    .map((r) => ({ title: titleFromMarkdown(r.markdown), uid: r.uid }))
    .filter((p) => p.title.startsWith("discourse-graph/nodes/"));

  const nodes = new Map<string, { text: string; children: TreeNode[] }>();
  await Promise.all(
    pages.map(async (page) => {
      const children = await getBasicTreeByParentUid(client, page.uid);
      const text = page.title.substring("discourse-graph/nodes/".length);
      nodes.set(page.uid, { text, children });
    }),
  );
  return nodes;
}
