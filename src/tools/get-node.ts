// Tool: get_node
// Get full details for a node by UID — title, content tree, metadata, creator.

// MODIFIED-START from getPageMetadata.ts
// — replaced window.roamAlphaAPI.q() with datalogQuery()
// — combined metadata + tree fetch in one tool

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import {
  DEFAULT_TREE_DEPTH,
  datalogQuery,
  getBasicTreeByParentUidWithMeta,
} from "../roam.js";
import type { TreeNode } from "../types.js";

export const GetNodeSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The block/page UID to fetch."),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum child depth to fetch. Default ${DEFAULT_TREE_DEPTH}. Increase for deeply nested pages.`,
    ),
});

export const getNodeDescription =
  "Get complete details for a node by its UID. Returns the title, " +
  "full block tree (content), creator, creation date, and last modified date.";

type NodeMetadata = {
  title: string;
  uid: string;
  created: number;
  modified: number;
  author_uid: string;
  author_name: string;
};
type NodeMetadataTuple = [string, number, number, string, string];

export const handleGetNode = async (
  client: RoamClient,
  uid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // Get metadata (title, timestamps, creator)
  const metaQuery = `[:find ?title ?created ?modified ?author-uid ?author-name
    :where
    [?node :block/uid "${uid}"]
    [?node :node/title ?title]
    [?node :create/time ?created]
    [(get-else $ ?node :edit/time ?created) ?modified]
    [?node :create/user ?user-eid]
    [?user-eid :user/uid ?author-uid]
    [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author-name]
  ]`;

  const rawMetadata = await datalogQuery<[string, number, number, string, string]>(client, metaQuery);
  const metadata = rawMetadata
    .filter((r) => r != null)
    .map(([title, created, modified, author_uid, author_name]) => ({
      title, uid, created, modified, author_uid, author_name,
    }));
  const meta = metadata[0];

  // Get full block tree
  const { tree: children, truncated } = await getBasicTreeByParentUidWithMeta(
    client,
    uid,
    maxDepth,
  );

  // Flatten tree to text for a readable summary
  const flattenTree = (nodes: TreeNode[], depth = 0): string =>
    nodes
      .map((n) => `${"  ".repeat(depth)}- ${n.text}${n.children.length ? "\n" + flattenTree(n.children, depth + 1) : ""}`)
      .join("\n");

  const result = {
    uid,
    title: meta?.title ?? "(block — not a page)",
    created: meta?.created,
    modified: meta?.modified,
    author: meta?.author_name,
    author_uid: meta?.author_uid,
    content: flattenTree(children),
    children_count: children.length,
    max_depth_used: maxDepth,
    depth_limited: truncated,
  };
  // MODIFIED-END

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
};
