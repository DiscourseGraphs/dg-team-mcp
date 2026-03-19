// Tool: get_relationships
// Find typed discourse relations for a node (e.g., what Supports this Claim?).
// Uses fireQuery with the relation definitions from getDiscourseNodeTypes.

// MODIFIED-START from getDiscourseContextResults.ts
// — replaced fireQuery browser calls with our ported fireQuery
// — simplified: no caching, no callbacks, no generateUID
// — takes relation definitions from getDiscourseNodeTypes instead of globals

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import fireQuery from "../query/fire-query.js";

export const GetRelationshipsSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The page UID to find discourse relations for."),
});

export const getRelationshipsDescription =
  "Find all typed discourse relations involving a node. For example, " +
  "what Evidence supports a Claim, what Questions a piece of Evidence " +
  "informs, etc. Returns results grouped by relation type.";

export const handleGetRelationships = async (
  client: RoamClient,
  targetUid: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const config = await getDiscourseNodeTypes(client);

  // Build a map of typeId → name for readable output
  const nodeNameByType: Record<string, string> = {};
  config.nodes.forEach((n) => {
    nodeNameByType[n.typeId] = n.name;
  });
  nodeNameByType["*"] = "Any";

  // For each relation, check if this node could be a source or destination,
  // then query for the other end.
  // Pattern from getDiscourseContextResults.ts:202-217
  const results: Array<{
    relation: string;
    direction: "forward" | "complement";
    results: Array<{ text: string; uid: string }>;
  }> = [];

  await Promise.all(
    config.relations.map(async (r) => {
      // Forward: this node is the source
      const forwardResults = await fireQuery(client, {
        returnNode: nodeNameByType[r.destination] || "node",
        conditions: [
          {
            source: nodeNameByType[r.destination] || "node",
            relation: r.complement,
            target: targetUid,
            uid: "rel-fwd",
            type: "clause",
          },
        ],
        selections: [],
      });

      if (forwardResults.length > 0) {
        results.push({
          relation: r.label,
          direction: "forward",
          results: forwardResults.filter((n) => n.uid !== targetUid),
        });
      }

      // Complement: this node is the destination
      const complementResults = await fireQuery(client, {
        returnNode: nodeNameByType[r.source] || "node",
        conditions: [
          {
            source: nodeNameByType[r.source] || "node",
            relation: r.label,
            target: targetUid,
            uid: "rel-comp",
            type: "clause",
          },
        ],
        selections: [],
      });

      if (complementResults.length > 0) {
        results.push({
          relation: r.complement,
          direction: "complement",
          results: complementResults.filter((n) => n.uid !== targetUid),
        });
      }
    }),
  );
  // MODIFIED-END

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            uid: targetUid,
            relation_count: results.length,
            relations: results,
          },
          null,
          2,
        ),
      },
    ],
  };
};
