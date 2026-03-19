// Tool: get_linked_nodes
// Find what a node references and what references it (backlinks).

// MODIFIED-START from getAllReferencesOnPage.ts
// — replaced window.roamAlphaAPI.data.backend.q() with datalogQuery()
// — combined outgoing refs + incoming backlinks in one tool
// — removed canvas-specific branch (not needed in MCP)

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";

export const GetLinkedNodesSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The page UID to find links for."),
  direction: z
    .enum(["outgoing", "incoming", "both"])
    .optional()
    .default("both")
    .describe("Direction of links. Default: both."),
});

export const getLinkedNodesDescription =
  "Find all nodes linked to/from a given page. Returns outgoing references " +
  "(pages this node links to) and/or incoming backlinks (pages that link to this node).";

type LinkResult = { uid: string; title: string };

export const handleGetLinkedNodes = async (
  client: RoamClient,
  uid: string,
  direction = "both",
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const result: { outgoing?: LinkResult[]; incoming?: LinkResult[] } = {};

  if (direction === "outgoing" || direction === "both") {
    // COPY from getAllReferencesOnPage.ts:38-46 (non-canvas branch)
    const outgoing = await datalogQuery<[string, string]>(
      client,
      `[:find ?ref-uid ?ref-title
        :where
        [?node :block/uid "${uid}"]
        [?b :block/page ?node]
        [?b :block/refs ?refPage]
        [?refPage :block/uid ?ref-uid]
        [?refPage :node/title ?ref-title]]`,
    );
    result.outgoing = outgoing
      .filter((r) => r != null && r[0] != null)
      .map(([uid, title]) => ({ uid, title }));
  }

  if (direction === "incoming" || direction === "both") {
    // Reverse of the above — find pages whose blocks reference this page
    const incoming = await datalogQuery<[string, string]>(
      client,
      `[:find ?source-uid ?source-title
        :where
        [?target :block/uid "${uid}"]
        [?b :block/refs ?target]
        [?b :block/page ?source]
        [?source :block/uid ?source-uid]
        [?source :node/title ?source-title]]`,
    );
    // Deduplicate by uid
    const seen = new Set<string>();
    result.incoming = incoming
      .filter((r) => r != null && r[0] != null)
      .filter(([uid]) => {
        if (seen.has(uid)) return false;
        seen.add(uid);
        return true;
      })
      .map(([uid, title]) => ({ uid, title }));
  }
  // MODIFIED-END

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
};
