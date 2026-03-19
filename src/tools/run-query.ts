// Tool: run_discourse_query
// Takes a query block UID from a Roam graph and executes the discourse graph
// query builder pipeline: read conditions → translate to Datalog → execute → return results.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getBasicTreeByParentUid } from "../roam.js";
import { getSubTree } from "../tree-utils.js";
import parseQuery from "../query/parse-query.js";
import fireQuery from "../query/fire-query.js";

export const RunQuerySchema = z.object({
  graph: z
    .string()
    .optional()
    .describe(
      "Graph name or nickname. Auto-selects if only one graph is configured.",
    ),
  query_uid: z
    .string()
    .describe(
      "The block UID of a discourse graph query block in Roam. " +
      "This is the parent block that contains the query builder configuration.",
    ),
});

export const runQueryDescription =
  "Execute a Discourse Graph query builder query from a Roam graph. " +
  "Takes the UID of a query block and runs the configured conditions " +
  "against the graph, returning matching nodes with their text and UIDs. " +
  "Supports conditions like 'has title', 'references', 'is in page', " +
  "'has child/parent/ancestor', 'created by', 'edited by', and more.";

export const handleRunQuery = async (
  client: RoamClient,
  queryUid: string,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> => {
  // 1. Read the query block's tree
  const tree = await getBasicTreeByParentUid(client, queryUid);

  // 2. Find the scratch node (query builder stores config under "scratch")
  const scratchNode = getSubTree(tree, "scratch");

  // If no scratch node, maybe the UID IS the scratch node
  const queryTree = scratchNode.uid ? scratchNode : { uid: queryUid, text: "", children: tree };

  // 3. Parse conditions and selections from the block tree
  const parsed = parseQuery(queryTree);

  // 4. Execute the query
  const results = await fireQuery(client, {
    conditions: parsed.conditions,
    selections: parsed.selections,
    returnNode: parsed.returnNode,
    isCustomEnabled: parsed.isCustomEnabled,
    customNode: parsed.customNode,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            query_uid: queryUid,
            conditions_count: parsed.conditions.length,
            is_custom: parsed.isCustomEnabled,
            result_count: results.length,
            results,
          },
          null,
          2,
        ),
      },
    ],
  };
};
