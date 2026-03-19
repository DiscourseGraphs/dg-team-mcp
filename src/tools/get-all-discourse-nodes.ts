// MODIFIED from apps/roam/src/utils/getAllDiscourseNodesSince.ts
// — replaced window.roamAlphaAPI.data.backend.q() with datalogQuery()
// — replaced extractRef with inline regex
// — takes RoamClient + node types as params instead of globals

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";

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

// COPY from apps/roam/src/utils/getAllDiscourseNodesSince.ts (type)
type RoamDiscourseNodeData = {
  text: string;
  source_local_id: string;
  created: string;
  last_modified: string;
  author_local_id: string;
  author_name: string;
  type: string;
};
type RoamDiscourseNodeTuple = [string, string, number, number, string, string, string];

// Inline extractRef (from roamjs-components/util/extractRef)
const extractRef = (ref: string | undefined): string =>
  ref?.match(/\(\(([^)]*)\)\)/)?.[1] || ref || "";

export const handleGetAllDiscourseNodes = async (
  client: RoamClient,
  since?: string,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> => {
  const config = await getDiscourseNodeTypes(client);
  const sinceMs = since ? new Date(since).getTime() : 0;
  const resultMap = new Map<string, RoamDiscourseNodeData>();

  await Promise.all(
    config.nodes.map(async (node) => {
      const regex = getDiscourseNodeFormatExpression(node.format);
      const regexPattern = regex.source
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');

      // COPY from getAllDiscourseNodesSince.ts:83-98 (page node query)
      const query = `[
        :find ?node-title ?uid ?nodeCreateTime ?nodeEditTime ?author_local_id ?author_name ?type
        :in $ ?since ?type
        :where
          [(re-pattern "${regexPattern}") ?title-regex]
          [?node :node/title ?node-title]
          [(re-find ?title-regex ?node-title)]
          [?node :block/uid ?uid]
          [?node :create/time ?nodeCreateTime]
          [?node :create/user ?user-eid]
          [?user-eid :user/uid ?author_local_id]
          [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author_name]
          [(get-else $ ?node :edit/time ?nodeCreateTime) ?nodeEditTime]
          [(> ?nodeEditTime ?since)]
      ]`;

      const rawResults = await datalogQuery<RoamDiscourseNodeTuple>(
        client,
        query,
        sinceMs,
        String(node.typeId),
      );
      const nodesOfType = rawResults
        .filter((r) => r != null)
        .map(([text, source_local_id, created, last_modified, author_local_id, author_name, type]) => ({
          text,
          source_local_id,
          created: String(created),
          last_modified: String(last_modified),
          author_local_id,
          author_name,
          type,
        }));

      nodesOfType.forEach((n) => {
        if (n?.source_local_id) {
          resultMap.set(n.source_local_id, n);
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
};
