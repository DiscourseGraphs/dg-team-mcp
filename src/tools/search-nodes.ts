// Tool: search_nodes
// Keyword search across discourse node titles, ranked by BM25 relevance.
// Titles are fetched via Datalog, then scored and ranked in JS.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-local";
import { datalogQuery } from "../roam.js";

export const SearchNodesSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  query: z
    .string()
    .describe(
      "Search keywords. Results are ranked by BM25 relevance — titles matching more (and rarer) query words rank higher. Not every word must appear.",
    ),
  node_type_format: z
    .string()
    .optional()
    .describe(
      "Optional regex pattern to filter by node type format (e.g., '\\\\[\\\\[CLM\\\\]\\\\]' for claims).",
    ),
  limit: z.number().optional().default(50).describe("Max results to return. Default 50."),
});

export const searchNodesDescription =
  "Search for discourse nodes by keywords in their titles, ranked by BM25 relevance " +
  "(titles matching only some query words are included, ranked lower). " +
  "Returns matching pages with their UIDs, titles, relevance scores, creation times, and authors.";

export type SearchResult = {
  text: string;
  uid: string;
  created: number;
  author: string;
};
type SearchResultTuple = [string, string, number, string];

export type RankedResult = SearchResult & { score: number };

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// A token matches a term when it contains it, preserving the old
// substring filter's stem-friendly behavior ("endocyto" ~ "endocytosis").
const termFrequency = (tokens: string[], term: string): number =>
  tokens.reduce((count, token) => (token.includes(term) ? count + 1 : count), 0);

export const rankTitlesBM25 = (
  candidates: SearchResult[],
  query: string,
): RankedResult[] => {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || candidates.length === 0) return [];

  const docs = candidates.map((candidate) => ({
    candidate,
    tokens: tokenize(candidate.text || ""),
  }));
  const n = docs.length;
  const avgLength = docs.reduce((sum, d) => sum + d.tokens.length, 0) / n || 1;

  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = docs.reduce(
      (count, d) => (termFrequency(d.tokens, term) > 0 ? count + 1 : count),
      0,
    );
    // The +1 inside the log keeps IDF positive even when every title matches.
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  return docs
    .map(({ candidate, tokens }) => {
      let score = 0;
      const lengthNorm = 1 - BM25_B + (BM25_B * tokens.length) / avgLength;
      for (const term of terms) {
        const tf = termFrequency(tokens, term);
        if (tf === 0) continue;
        score += (idf.get(term) ?? 0) * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm));
      }
      return { ...candidate, score };
    })
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.created || 0) - (a.created || 0) ||
        (a.uid < b.uid ? -1 : 1),
    );
};

export const handleSearchNodes = async (
  client: RoamClient,
  query: string,
  nodeTypeFormat?: string,
  limit = 50,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // MODIFIED-START from getAllReferencesOnPage.ts pattern
  // — fetches all titled nodes, then BM25-ranks them in JS
  if (tokenize(query).length === 0) {
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

  const ranked = rankTitlesBM25(allResults, query)
    .slice(0, limit)
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ count: ranked.length, results: ranked }, null, 2),
      },
    ],
  };
};
