// Tool: get_node_neighborhood
// K-hop BFS traversal from a node, following references.

// MODIFIED-START from ExportDiscourseContext.tsx:getReferencesByDegree
// — replaced window.roamAlphaAPI with datalogQuery
// — simplified: returns flat list of discovered nodes per hop level

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";

export const GetNodeNeighborhoodSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The starting page UID for traversal."),
  depth: z.number().min(1).max(4).default(1).describe("Number of hops to traverse (1-4). Default 1."),
  direction: z
    .enum(["outgoing", "incoming", "both"])
    .optional()
    .default("both")
    .describe("Direction of traversal. Default: both."),
});

export const getNodeNeighborhoodDescription =
  "Perform a breadth-first traversal from a node, following page references " +
  "up to N hops deep. Returns nodes organized by hop distance. " +
  "Useful for exploring the neighborhood of a discourse node.";

type NeighborNode = { uid: string; title: string };

const getOutgoing = async (
  client: RoamClient,
  uid: string,
): Promise<NeighborNode[]> => {
  const results = await datalogQuery<[string, string]>(
    client,
    `[:find ?ref-uid ?ref-title
      :where
      [?node :block/uid "${uid}"]
      [?b :block/page ?node]
      [?b :block/refs ?refPage]
      [?refPage :block/uid ?ref-uid]
      [?refPage :node/title ?ref-title]]`,
  );
  return results
    .filter((r) => r != null && r[0] != null)
    .map(([uid, title]) => ({ uid, title }));
};

const getIncoming = async (
  client: RoamClient,
  uid: string,
): Promise<NeighborNode[]> => {
  const results = await datalogQuery<[string, string]>(
    client,
    `[:find ?source-uid ?source-title
      :where
      [?target :block/uid "${uid}"]
      [?b :block/refs ?target]
      [?b :block/page ?source]
      [?source :block/uid ?source-uid]
      [?source :node/title ?source-title]]`,
  );
  const seen = new Set<string>();
  return results
    .filter((r) => r != null && r[0] != null)
    .filter(([uid]) => {
    if (seen.has(uid)) return false;
    seen.add(uid);
    return true;
  }).map(([uid, title]) => ({ uid, title }));
};

// COPY pattern from ExportDiscourseContext.tsx:getReferencesByDegree
// — BFS with visited set, returns nodes grouped by hop level
export const handleGetNodeNeighborhood = async (
  client: RoamClient,
  startUid: string,
  depth: number,
  direction: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const visited = new Set<string>([startUid]);
  const hops: Array<{ hop: number; nodes: NeighborNode[] }> = [];
  let currentFrontier = [startUid];

  for (let hop = 1; hop <= depth; hop++) {
    const nextFrontier: NeighborNode[] = [];

    await Promise.all(
      currentFrontier.map(async (uid) => {
        let neighbors: NeighborNode[] = [];
        if (direction === "outgoing" || direction === "both") {
          neighbors = neighbors.concat(await getOutgoing(client, uid));
        }
        if (direction === "incoming" || direction === "both") {
          neighbors = neighbors.concat(await getIncoming(client, uid));
        }
        for (const n of neighbors) {
          if (!visited.has(n.uid)) {
            visited.add(n.uid);
            nextFrontier.push(n);
          }
        }
      }),
    );

    // Deduplicate within this hop
    const seen = new Set<string>();
    const deduped = nextFrontier.filter((n) => {
      if (seen.has(n.uid)) return false;
      seen.add(n.uid);
      return true;
    });

    hops.push({ hop, nodes: deduped });
    currentFrontier = deduped.map((n) => n.uid);

    if (currentFrontier.length === 0) break;
  }
  // MODIFIED-END

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            start_uid: startUid,
            depth,
            direction,
            total_nodes: hops.reduce((sum, h) => sum + h.nodes.length, 0),
            hops,
          },
          null,
          2,
        ),
      },
    ],
  };
};
