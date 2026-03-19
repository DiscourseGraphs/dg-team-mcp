// Tool: search_nodes
// Full-text keyword search across discourse node titles and content.
// Uses Datalog with clojure.string/includes? for matching.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";

export const SearchNodesSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  query: z.string().describe("Search keywords. All words must appear in the node title."),
  node_type_format: z
    .string()
    .optional()
    .describe(
      "Optional regex pattern to filter by node type format (e.g., '\\\\[\\\\[CLM\\\\]\\\\]' for claims).",
    ),
  limit: z.number().optional().default(50).describe("Max results to return. Default 50."),
});

export const searchNodesDescription =
  "Search for discourse nodes by keyword in their titles. " +
  "Returns matching pages with their UIDs, titles, creation times, and authors.";

type SearchResult = {
  text: string;
  uid: string;
  created: number;
  author: string;
};
type SearchResultTuple = [string, string, number, string];

export const handleSearchNodes = async (
  client: RoamClient,
  query: string,
  nodeTypeFormat?: string,
  limit = 50,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // MODIFIED-START from getAllReferencesOnPage.ts pattern
  // — uses clojure.string/includes? for keyword search instead of block/refs
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { content: [{ type: "text", text: JSON.stringify({ count: 0, results: [] }) }] };
  }

  // Query all titled nodes, filter by keywords in JS
  // (Roam Datalog doesn't support clojure.string/lower-case)
  const formatFilter = nodeTypeFormat
    ? `[(re-pattern "${nodeTypeFormat}") ?fmt-regex]\n    [(re-find ?fmt-regex ?title)]`
    : "";

  const datalog = `[:find ?title ?uid ?created ?author-name
    :where
    [?node :node/title ?title]
    [?node :block/uid ?uid]
    [?node :create/time ?created]
    [?node :create/user ?user-eid]
    [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author-name]
    ${formatFilter}
  ]`;
  // MODIFIED-END

  const rawResults = await datalogQuery<SearchResultTuple>(client, datalog);
  const allResults = rawResults
    .filter((r) => r != null && r[0] != null)
    .map(([text, uid, created, author]) => ({ text, uid, created, author }));

  const sorted = allResults
    .filter((r) => {
      const titleLower = (r.text || "").toLowerCase();
      return words.every((w) => titleLower.includes(w));
    })
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, limit);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ count: sorted.length, results: sorted }, null, 2),
      },
    ],
  };
};
