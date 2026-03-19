import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getDiscourseNodeTypes } from "../discourse-config.js";

export const GetNodeTypesSchema = z.object({
  graph: z
    .string()
    .optional()
    .describe(
      "Graph name or nickname. Auto-selects if only one graph is configured.",
    ),
});

export const getNodeTypesDescription =
  "Get all discourse node types and relations configured in a Roam graph " +
  "with the Discourse Graph extension. Returns node names, type IDs, " +
  "formats, shortcuts, descriptions, canvas settings, and relation " +
  "definitions (label, source, destination, complement).";

export const handleGetNodeTypes = async (
  client: RoamClient,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const result = await getDiscourseNodeTypes(client);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
};
