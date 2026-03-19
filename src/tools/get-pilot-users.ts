// Tool: get_pilot_users
// Find all pilot users in the graph. Pilot users are discourse nodes
// of type "UserPilot". Uses the node type format to find matching pages,
// or falls back to searching for the tag.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";

export const GetPilotUsersSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
});

export const getPilotUsersDescription =
  "Get all pilot users configured in the discourse graph. Returns their " +
  "page titles, UIDs, and any metadata. Pilot users are discourse nodes " +
  "of type UserPilot.";

export const handleGetPilotUsers = async (
  client: RoamClient,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // 1. Find the UserPilot node type config
  const config = await getDiscourseNodeTypes(client);
  const pilotNodeType = config.nodes.find(
    (n) => n.name.toLowerCase() === "userpilot" || n.name.toLowerCase() === "user pilot",
  );

  if (!pilotNodeType) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "No UserPilot node type found in discourse graph config",
            available_types: config.nodes.map((n) => n.name),
          }, null, 2),
        },
      ],
    };
  }

  // 2. Find all pages matching the UserPilot format
  type SearchResponse = {
    total: number;
    results: Array<{ uid: string; markdown: string; type?: string }>;
  };

  // Search by format prefix first (most reliable for finding pages),
  // fall back to tag, then node type name
  const searchQuery = pilotNodeType.format
    ? pilotNodeType.format.split("{")[0].trim()
    : pilotNodeType.tag
      ? pilotNodeType.tag.replace(/^#/, "")
      : pilotNodeType.name;

  const response = await client.call<SearchResponse>("data.ai.search", [
    { query: searchQuery, scope: "pages", limit: 1000 },
  ]);
  const searchResults = response.result?.results ?? [];

  // 3. Filter to only pages that match the format regex (if format exists)
  const formatRegex = pilotNodeType.format
    ? getDiscourseNodeFormatExpression(pilotNodeType.format)
    : null;

  const titleFromMarkdown = (md: string): string => {
    const match = md.match(/^#\s+(.+?)(?:\s*<roam|$)/);
    return match?.[1] ?? md;
  };

  const pilots = searchResults
    .map((r) => ({
      uid: r.uid,
      title: titleFromMarkdown(r.markdown),
    }))
    .filter((p) => {
      if (formatRegex) return formatRegex.test(p.title);
      // No format — accept any result from search
      return true;
    });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            node_type: pilotNodeType.name,
            format: pilotNodeType.format,
            tag: pilotNodeType.tag,
            count: pilots.length,
            pilots,
          },
          null,
          2,
        ),
      },
    ],
  };
};
