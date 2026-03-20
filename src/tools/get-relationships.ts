// Tool: get_relationships
// Find typed discourse relations for a node (e.g., what Supports this Claim?).
// Uses fireQuery with the relation definitions from getDiscourseNodeTypes.

// MODIFIED-START from getDiscourseContextResults.ts
// — replaced fireQuery browser calls with our ported fireQuery
// — keeps a small in-memory cache like the extension to avoid repeated heavy queries
// — takes relation definitions from getDiscourseNodeTypes instead of globals

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import compileDatalog from "../query/compile-datalog.js";
import { getInternalDiscourseConfig } from "../discourse-config.js";
import { discourseNodeToDatalog } from "../query/discourse-node-utils.js";
import { fireQueryDetailed } from "../query/fire-query.js";
import { registerDiscourseTranslators } from "../query/register-discourse-translators.js";
import type { Result as QueryResult } from "../query/types.js";
import { datalogQuery } from "../roam.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";
import type {
  InternalDiscourseNodeType,
  InternalDiscourseRelationType,
} from "../types.js";

export const GetRelationshipsSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The page UID to find discourse relations for."),
});

export const getRelationshipsDescription =
  "Find all typed discourse relations involving a node. For example, " +
  "what Evidence supports a Claim, what Questions a piece of Evidence " +
  "informs, etc. Returns results grouped by relation type.";

const CACHE_TIMEOUT = 1000 * 60 * 5;

const relationshipResultCache = new Map<
  string,
  {
    expiresAt: number;
    results: QueryResult[];
  }
>();

const discourseNodeTypeCache = new Map<
  string,
  {
    expiresAt: number;
    nodeTypeId: string | null;
  }
>();

const getClientGraphKey = (client: RoamClient) =>
  String((client as unknown as { graphName?: string }).graphName || "default");

const getCacheKey = ({
  client,
  uid,
  relationLabel,
  returnNode,
}: {
  client: RoamClient;
  uid: string;
  relationLabel: string;
  returnNode: string;
}) => `${getClientGraphKey(client)}::${uid}::${relationLabel}::${returnNode}`;

const getNodeTypeCacheKey = (client: RoamClient, uid: string) =>
  `${getClientGraphKey(client)}::${uid}`;

const getCachedValue = <T,>(
  cache: Map<string, { expiresAt: number; results?: T; nodeTypeId?: T }>,
  key: string,
): T | undefined => {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return (("results" in cached ? cached.results : cached.nodeTypeId) as T | undefined);
};

const setResultCache = (
  key: string,
  results: QueryResult[],
) => {
  relationshipResultCache.set(key, {
    expiresAt: Date.now() + CACHE_TIMEOUT,
    results,
  });
};

const setNodeTypeCache = (key: string, nodeTypeId: string | null) => {
  discourseNodeTypeCache.set(key, {
    expiresAt: Date.now() + CACHE_TIMEOUT,
    nodeTypeId,
  });
};

const getNodeMetadata = async (client: RoamClient, uid: string) => {
  const rows = await datalogQuery<[string, string]>(
    client,
    `[:find ?title ?string
      :where
      [?node :block/uid "${uid}"]
      [(get-else $ ?node :node/title "") ?title]
      [(get-else $ ?node :block/string "") ?string]]`,
  );
  const [title = "", text = ""] = rows[0] || [];
  return { title, text };
};

const matchesNodeTypeByMetadata = ({
  node,
  title,
}: {
  node: InternalDiscourseNodeType;
  title: string;
}) => {
  if (
    node.specification.length === 1 &&
    node.specification[0].type === "clause" &&
    node.specification[0].relation === "has title" &&
    !node.specification[0].not
  ) {
    const pattern = node.specification[0].target;
    const match = /^\/(.+)\/(i)?$/.exec(pattern);
    if (match) {
      return new RegExp(match[1], match[2] || "").test(title);
    }
  }

  if (!node.specification.length) {
    return getDiscourseNodeFormatExpression(node.format).test(title);
  }

  return undefined;
};

const matchesNodeTypeByUid = async ({
  client,
  uid,
  node,
}: {
  client: RoamClient;
  uid: string;
  node: InternalDiscourseNodeType;
}) => {
  const whereClauses = discourseNodeToDatalog({
    freeVar: "node",
    node,
  })
    .map((clause) => compileDatalog(clause, 1))
    .join("\n");

  const rows = await datalogQuery<[string]>(
    client,
    `[:find ?node
      :where
      [?node :block/uid "${uid}"]
${whereClauses}
    ]`,
  );
  return rows.length > 0;
};

const findDiscourseNodeType = async ({
  client,
  uid,
  nodes,
}: {
  client: RoamClient;
  uid: string;
  nodes: InternalDiscourseNodeType[];
}) => {
  const nodeTypeCacheKey = getNodeTypeCacheKey(client, uid);
  const cachedNodeType = getCachedValue<string | null>(
    discourseNodeTypeCache as Map<
      string,
      { expiresAt: number; nodeTypeId?: string | null }
    >,
    nodeTypeCacheKey,
  );
  if (typeof cachedNodeType !== "undefined") return cachedNodeType;

  const { title } = await getNodeMetadata(client, uid);

  for (const node of nodes) {
    const metadataMatch = matchesNodeTypeByMetadata({ node, title });
    if (metadataMatch === true) {
      setNodeTypeCache(nodeTypeCacheKey, node.typeId);
      return node.typeId;
    }
    if (metadataMatch === false) continue;

    if (await matchesNodeTypeByUid({ client, uid, node })) {
      setNodeTypeCache(nodeTypeCacheKey, node.typeId);
      return node.typeId;
    }
  }

  setNodeTypeCache(nodeTypeCacheKey, null);
  return null;
};

const buildSelections = (
  triples: readonly (readonly [string, string, string])[],
  uid: string,
) => {
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

const getDedupedRelations = (relations: InternalDiscourseRelationType[]) =>
  Array.from(
    new Map(
      relations.map((relation) => [
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

const runWithConcurrencyLimit = async <T,>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) => {
  const pending = [...items];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (pending.length) {
      const next = pending.shift();
      if (!next) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
};

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

    const targetNodeType = await findDiscourseNodeType({
      client,
      uid: targetUid,
      nodes: config.nodes,
    });

    if (!targetNodeType) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                uid: targetUid,
                relation_count: 0,
                relations: [],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const relevantRelations = getDedupedRelations(config.relations).flatMap((r) => {
      const matches: Array<{
        relation: InternalDiscourseRelationType;
        direction: "forward" | "complement";
      }> = [];

      if (r.source === "*" || r.source === targetNodeType) {
        matches.push({ relation: r, direction: "forward" });
      }

      if (r.destination === "*" || r.destination === targetNodeType) {
        matches.push({ relation: r, direction: "complement" });
      }

      return matches;
    });

    const results: Array<{
      relation: string;
      direction: "forward" | "complement";
      results: QueryResult[];
    }> = [];

    await runWithConcurrencyLimit(relevantRelations, 2, async ({ relation: r, direction }) => {
      const isComplement = direction === "complement";
      const returnType = isComplement ? r.source : r.destination;
      const returnNode = nodeNameByType[returnType] || "node";
      const relationLabel = isComplement ? r.label : r.complement;
      const resultLabel = isComplement ? r.complement : r.label;
      const queryUid = `${r.id}-${direction}`;
      const cacheKey = getCacheKey({
        client,
        uid: targetUid,
        relationLabel,
        returnNode,
      });

      const cachedResults = getCachedValue<QueryResult[]>(
        relationshipResultCache as Map<string, { expiresAt: number; results?: QueryResult[] }>,
        cacheKey,
      );

      const queryResults =
        cachedResults ||
        (
          await fireQueryDetailed(client, {
            returnNode,
            conditions: [
              {
                source: returnNode,
                relation: relationLabel,
                target: targetUid,
                uid: queryUid,
                type: "clause",
              },
            ],
            selections: buildSelections(r.triples, queryUid),
          })
        ).results;

      if (!cachedResults) {
        setResultCache(cacheKey, queryResults);
      }

      const filteredResults = queryResults.filter((n) => n.uid !== targetUid);
      if (filteredResults.length > 0) {
        results.push({
          relation: resultLabel,
          direction,
          results: filteredResults,
        });
      }
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              uid: targetUid,
              node_type: nodeNameByType[targetNodeType] || targetNodeType,
              relevant_relation_queries: relevantRelations.length,
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
