// Tool: get_relationships
// Find typed discourse relations for a node (e.g., what Supports this Claim?).
// Uses fireQuery with the relation definitions from getDiscourseNodeTypes.

// MODIFIED-START from getDiscourseContextResults.ts
// — replaced fireQuery browser calls with our ported fireQuery
// — simplified: no caching, no callbacks, no generateUID
// — takes relation definitions from getDiscourseNodeTypes instead of globals

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getInternalDiscourseConfig } from "../discourse-config.js";
import { fireQueryDetailed } from "../query/fire-query.js";
import { registerDiscourseTranslators } from "../query/register-discourse-translators.js";
import type { Result as QueryResult } from "../query/types.js";

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
  const config = await getInternalDiscourseConfig(client);
  const unregister = registerDiscourseTranslators(config);

  try {
    const nodeNameByType: Record<string, string> = {};
    config.nodes.forEach((n) => {
      nodeNameByType[n.typeId] = n.name;
    });
    nodeNameByType["*"] = "Any";

    const dedupedRelations = Array.from(
      new Map(
        config.relations.map((relation) => [
          [
            relation.id,
            relation.label,
            relation.source,
            relation.destination,
            relation.complement,
          ].join("::"),
          relation,
        ]),
      ).values(),
    );

    const buildSelections = (triples: readonly (readonly [string, string, string])[], uid: string) => {
      if (triples.some((triple) => triple.some((value) => /context/i.test(value)))) {
        return [
          {
            uid: `${uid}-context`,
            label: "context",
            text: `node:${uid}-Context`,
          },
        ];
      }

      if (triples.some((triple) => triple.some((value) => /anchor/i.test(value)))) {
        return [
          {
            uid: `${uid}-anchor`,
            label: "anchor",
            text: `node:${uid}-Anchor`,
          },
        ];
      }

      return [];
    };

    const results: Array<{
      relation: string;
      direction: "forward" | "complement";
      results: QueryResult[];
    }> = [];

    await Promise.all(
      dedupedRelations.map(async (r) => {
        const forwardUid = `${r.id}-forward`;
        const forwardSelections = buildSelections(r.triples, forwardUid);
        const forwardResults = await fireQueryDetailed(client, {
          returnNode: nodeNameByType[r.destination] || "node",
          conditions: [
            {
              source: nodeNameByType[r.destination] || "node",
              relation: r.complement,
              target: targetUid,
              uid: forwardUid,
              type: "clause",
            },
          ],
          selections: forwardSelections,
        });

        const filteredForward = forwardResults.results.filter(
          (n) => n.uid !== targetUid,
        );
        if (filteredForward.length > 0) {
          results.push({
            relation: r.label,
            direction: "forward",
            results: filteredForward,
          });
        }

        const complementUid = `${r.id}-complement`;
        const complementSelections = buildSelections(r.triples, complementUid);
        const complementResults = await fireQueryDetailed(client, {
          returnNode: nodeNameByType[r.source] || "node",
          conditions: [
            {
              source: nodeNameByType[r.source] || "node",
              relation: r.label,
              target: targetUid,
              uid: complementUid,
              type: "clause",
            },
          ],
          selections: complementSelections,
        });

        const filteredComplement = complementResults.results.filter(
          (n) => n.uid !== targetUid,
        );
        if (filteredComplement.length > 0) {
          results.push({
            relation: r.complement,
            direction: "complement",
            results: filteredComplement,
          });
        }
      }),
    );

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
  } finally {
    unregister();
  }
};
