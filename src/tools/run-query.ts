// Tool: run_discourse_query
// Takes a query block UID from a Roam graph and executes the discourse graph
// query builder pipeline: read conditions → translate to Datalog → execute → return results.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getBasicTreeByParentUid } from "../roam.js";
import { getSubTree } from "../tree-utils.js";
import parseQuery from "../query/parse-query.js";
import { fireQueryDetailed } from "../query/fire-query.js";
import { getInternalDiscourseConfig } from "../discourse-config.js";
import { registerDiscourseTranslators } from "../query/register-discourse-translators.js";

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
  inputs: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "Optional values for query builder inputs used by conditions like ':in variable'.",
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
  inputs?: Record<string, string | number>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> => {
  const config = await getInternalDiscourseConfig(client);
  const unregister = registerDiscourseTranslators(config);

  try {
    const tree = await getBasicTreeByParentUid(client, queryUid);

    const scratchNode = getSubTree(tree, "scratch");

    const queryTree = scratchNode.uid
      ? scratchNode
      : { uid: queryUid, text: "", children: tree };

    const parsed = parseQuery(queryTree);

    const { results, unsupportedSelections } = await fireQueryDetailed(client, {
      conditions: parsed.conditions,
      selections: parsed.selections,
      returnNode: parsed.returnNode,
      isCustomEnabled: parsed.isCustomEnabled,
      customNode: parsed.customNode,
      inputs,
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
              input_count: Object.keys(inputs || {}).length,
              result_count: results.length,
              unsupported_selections: unsupportedSelections,
              results,
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
