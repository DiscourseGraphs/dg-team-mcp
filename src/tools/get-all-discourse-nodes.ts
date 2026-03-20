// MODIFIED from apps/roam/src/utils/getAllDiscourseNodesSince.ts
// - uses tuple-only Local API queries
// - uses the shared discourse translator registration
// - includes embedding-ref-backed node text overrides

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";
import { getInternalDiscourseConfig } from "../discourse-config.js";
import { registerDiscourseTranslators } from "../query/register-discourse-translators.js";
import { discourseNodeToDatalog } from "../query/discourse-node-utils.js";
import compileDatalog from "../query/compile-datalog.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";
import type { InternalDiscourseNodeType } from "../types.js";

export const GetAllDiscourseNodesSchema = z.object({
  graph: z
    .string()
    .optional()
    .describe(
      "Graph name or nickname. Auto-selects if only one graph is configured.",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "ISO date string. Only return nodes modified after this date. Defaults to all time.",
    ),
});

export const getAllDiscourseNodesDescription =
  "Get all discourse node instances from a Roam graph. Returns the actual " +
  "pages/blocks that match configured discourse node types (e.g., all Claims, " +
  "all Evidence). Each result includes the node text, UID, type, author, " +
  "and timestamps.";

type RoamDiscourseNodeData = {
  text: string;
  source_local_id: string;
  created: string;
  last_modified: string;
  author_local_id: string;
  author_name: string;
  type: string;
  node_title?: string;
};

type GenericNodeTuple = [
  string,
  string,
  string,
  number,
  number,
  string,
  string,
];

type EmbeddedNodeTuple = [
  string,
  string,
  number,
  number,
  string,
  string,
  string,
];

const extractRef = (ref: string | undefined): string =>
  ref?.match(/\(\(([^)]*)\)\)/)?.[1] || ref || "";

const getNodeInstancesQuery = (node: InternalDiscourseNodeType) => {
  const whereClauses = discourseNodeToDatalog({
    freeVar: "node",
    node,
  })
    .map((clause) => compileDatalog(clause, 1))
    .join("\n");

  return `[
    :find ?node-text ?node-title ?uid ?nodeCreateTime ?nodeEditTime ?author_local_id ?author_name
    :in $ ?since
    :where
${whereClauses}
      [(get-else $ ?node :block/string "") ?node-text]
      [(get-else $ ?node :node/title "") ?node-title]
      [?node :block/uid ?uid]
      [?node :create/time ?nodeCreateTime]
      [(get-else $ ?node :edit/time ?nodeCreateTime) ?nodeEditTime]
      [?node :create/user ?user-eid]
      [?user-eid :user/uid ?author_local_id]
      [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author_name]
      [(> ?nodeEditTime ?since)]
  ]`;
};

const getEmbeddedNodeQuery = (node: InternalDiscourseNodeType) => {
  const regex = getDiscourseNodeFormatExpression(node.format);
  const regexPattern = regex.source.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  return `[
    :find ?childString ?nodeUid ?nodeCreateTime ?nodeEditTime ?author_local_id ?author_name ?node_title
    :in $ ?firstChildUid ?since
    :where
      [(re-pattern "${regexPattern}") ?title-regex]
      [?node :node/title ?node_title]
      [(re-find ?title-regex ?node_title)]
      [?node :block/uid ?nodeUid]
      [?node :create/time ?nodeCreateTime]
      [(get-else $ ?node :edit/time ?nodeCreateTime) ?nodeEditTime]
      [?settings-block :block/uid ?firstChildUid]
      [?settings-block :block/string ?firstChildString]
      [?body-group :block/page ?node]
      [?body-group :block/string ?firstChildString]
      [?body-group :block/children ?child]
      [?child :block/order 0]
      [?child :block/string ?childString]
      [(get-else $ ?child :edit/time ?nodeCreateTime) ?childEditTime]
      [?child :create/user ?user-eid]
      [?user-eid :user/uid ?author_local_id]
      [(get-else $ ?child :edit/user ?user-eid) ?edit-user-eid]
      [(get-else $ ?edit-user-eid :user/display-name "Anonymous User") ?author_name]
      [or
        [(> ?childEditTime ?since)]
        [(> ?nodeEditTime ?since)]]
  ]`;
};

export const handleGetAllDiscourseNodes = async (
  client: RoamClient,
  since?: string,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> => {
  const config = await getInternalDiscourseConfig(client);
  const unregister = registerDiscourseTranslators(config);

  try {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const resultMap = new Map<string, RoamDiscourseNodeData>();
    const nodes = config.nodes.filter((node) => node.backedBy !== "default");

    await Promise.all(
      nodes.map(async (node) => {
        const rawResults = await datalogQuery<GenericNodeTuple>(
          client,
          getNodeInstancesQuery(node),
          sinceMs,
        );

        rawResults
          .filter((row) => row != null)
          .map(
            ([
              nodeText,
              nodeTitle,
              source_local_id,
              created,
              last_modified,
              author_local_id,
              author_name,
            ]) =>
              ({
                text: nodeTitle || nodeText,
                node_title: nodeTitle || undefined,
                source_local_id,
                created: String(created),
                last_modified: String(last_modified),
                author_local_id,
                author_name,
                type: String(node.typeId),
              }) satisfies RoamDiscourseNodeData,
          )
          .forEach((result) => {
            if (result.source_local_id) {
              resultMap.set(result.source_local_id, result);
            }
          });

        const embeddingUid = extractRef(node.embeddingRef);
        if (!embeddingUid || !node.format) return;

        const embeddedResults = await datalogQuery<EmbeddedNodeTuple>(
          client,
          getEmbeddedNodeQuery(node),
          embeddingUid,
          sinceMs,
        );

        embeddedResults
          .filter((row) => row != null)
          .map(
            ([
              text,
              source_local_id,
              created,
              last_modified,
              author_local_id,
              author_name,
              node_title,
            ]) =>
              ({
                text,
                node_title: node_title || undefined,
                source_local_id,
                created: String(created),
                last_modified: String(last_modified),
                author_local_id,
                author_name,
                type: String(node.typeId),
              }) satisfies RoamDiscourseNodeData,
          )
          .forEach((result) => {
            if (result.source_local_id) {
              resultMap.set(result.source_local_id, result);
            }
          });
      }),
    );

    const results = Array.from(resultMap.values());
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: results.length, nodes: results },
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
