// Tool: get_researcher_contributions
// Find discourse nodes created by a specific author, or list all contributors.

// MODIFIED-START from getAllDiscourseNodesSince.ts + predefinedSelections.ts
// — uses the :create/user Datalog pattern from those files
// — combined into a single tool that can query by author or list all authors

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";

export const GetResearcherContributionsSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  author: z
    .string()
    .optional()
    .describe(
      "Author display name to filter by (case-insensitive partial match). " +
      "If omitted, returns a summary of all contributors.",
    ),
  node_type_format: z
    .string()
    .optional()
    .describe("Optional regex to filter by node type format."),
  limit: z.number().optional().default(100).describe("Max results. Default 100."),
});

export const getResearcherContributionsDescription =
  "Find discourse nodes by author, or get a summary of all contributors. " +
  "When an author name is provided, returns their nodes. " +
  "When omitted, returns contributor statistics (node counts per author).";

type ContributionResult = {
  title: string;
  uid: string;
  created: number;
  author: string;
};
type ContributionResultTuple = [string, string, number, string];

type AuthorSummary = {
  author: string;
  node_count: number;
};

export const handleGetResearcherContributions = async (
  client: RoamClient,
  author?: string,
  nodeTypeFormat?: string,
  limit = 100,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  if (author) {
    // Find nodes by a specific author
    // COPY pattern from getAllDiscourseNodesSince.ts:93-95 (:create/user join)
    const formatFilter = nodeTypeFormat
      ? `[(re-pattern "${nodeTypeFormat}") ?fmt-regex]\n      [(re-find ?fmt-regex ?title)]`
      : "";

    // Query all nodes, filter by author in JS (Roam Datalog doesn't support clojure.string/lower-case)
    const rawResults = await datalogQuery<ContributionResultTuple>(
      client,
      `[:find ?title ?uid ?created ?author-name
        :where
        [?node :node/title ?title]
        [?node :block/uid ?uid]
        [?node :create/time ?created]
        [?node :create/user ?user-eid]
        [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author-name]
        ${formatFilter}
      ]`,
    );
    const allResults = rawResults
      .filter((r) => r != null && r[0] != null)
      .map(([title, uid, created, author]) => ({ title, uid, created, author }));

    const authorLower = author.toLowerCase();
    const sorted = allResults
      .filter((r) => (r.author || "").toLowerCase().includes(authorLower))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { author, count: sorted.length, nodes: sorted },
            null,
            2,
          ),
        },
      ],
    };
  }

  // No author specified — return contributor summary
  const rawAuthors = await datalogQuery<[string]>(
    client,
    `[:find ?author-name
      :where
      [?node :node/title _]
      [?node :create/user ?user-eid]
      [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author-name]
    ]`,
  );
  const results = rawAuthors
    .filter((r) => r != null)
    .map(([author]) => ({ author }));

  // Count nodes per author
  const counts: Record<string, number> = {};
  results.forEach((r) => {
    counts[r.author] = (counts[r.author] || 0) + 1;
  });

  const summary: AuthorSummary[] = Object.entries(counts)
    .map(([author, node_count]) => ({ author, node_count }))
    .sort((a, b) => b.node_count - a.node_count);
  // MODIFIED-END

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { contributor_count: summary.length, contributors: summary },
          null,
          2,
        ),
      },
    ],
  };
};
