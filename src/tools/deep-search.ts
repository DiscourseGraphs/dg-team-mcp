// Tool: deep_pilot_search
// Combined index + live search across pilot user pages in one call.
// Searches the pre-built knowledge index for classified insights,
// then optionally runs the live layered search for current block matches.
// Returns both views so the caller can synthesize a complete answer.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { readPilotIndex, INDEX_PATH } from "../pilot-index.js";
import type { PilotIndex, PilotTopicItem } from "../pilot-index.js";
import { handleGetPilotSupport } from "./get-pilot-support.js";

export const DeepSearchSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  query: z
    .string()
    .describe(
      "Feature, topic, or keyword to search for (e.g., 'Canvas', 'navigation', 'onboarding').",
    ),
  search_terms: z
    .array(z.string())
    .optional()
    .describe("Additional synonyms or related terms to broaden the search."),
  skip_live_search: z
    .boolean()
    .optional()
    .describe(
      "If true, only search the index (instant). If false (default), also run " +
        "live layered search across all pilot pages (thorough but slower).",
    ),
});

export const deepSearchDescription =
  "Deep search across pilot user pages. Combines two strategies in one call: " +
  "(1) searches the pre-built pilot knowledge index for classified insights — " +
  "which pilots discuss the query, under what topics, with summaries and citations; " +
  "(2) runs the live layered search (wikilinks → text+sentiment → any-word) " +
  "for current block-level matches. Use skip_live_search=true for instant " +
  "index-only results. Returns both views for comprehensive pilot analysis.";

interface IndexMatch {
  pilot_name: string;
  pilot_uid: string;
  last_indexed: string;
  topics: Record<
    string,
    {
      summary: string;
      matching_items: PilotTopicItem[];
    }
  >;
}

function searchIndex(
  index: PilotIndex,
  query: string,
  searchTerms: string[],
): { matches: IndexMatch[]; rollup_matches: Record<string, unknown> } {
  const terms = [query, ...searchTerms].map((t) => t.toLowerCase());
  const matches: IndexMatch[] = [];

  for (const [uid, pilot] of Object.entries(index.pilots)) {
    const matchingTopics: IndexMatch["topics"] = {};

    for (const [topicKey, topic] of Object.entries(pilot.topics)) {
      const summaryMatch = terms.some((t) =>
        topic.summary.toLowerCase().includes(t),
      );
      const matchingItems = topic.items.filter((item) =>
        terms.some((t) => item.text.toLowerCase().includes(t)),
      );

      if (summaryMatch || matchingItems.length > 0) {
        matchingTopics[topicKey] = {
          summary: topic.summary,
          matching_items: matchingItems,
        };
      }
    }

    if (Object.keys(matchingTopics).length > 0) {
      matches.push({
        pilot_name: pilot.name,
        pilot_uid: uid,
        last_indexed: pilot.last_indexed,
        topics: matchingTopics,
      });
    }
  }

  // Also search rollups
  const rollupMatches: Record<string, unknown> = {};
  for (const [key, rollup] of Object.entries(index.rollups)) {
    const summaryMatch = terms.some((t) =>
      rollup.summary.toLowerCase().includes(t),
    );
    const rankedMatch = rollup.ranked?.filter((r) =>
      terms.some((t) => r.item.toLowerCase().includes(t)),
    );

    if (summaryMatch || (rankedMatch && rankedMatch.length > 0)) {
      rollupMatches[key] = {
        summary: rollup.summary,
        matching_ranked:
          rankedMatch && rankedMatch.length > 0 ? rankedMatch : undefined,
      };
    }
  }

  return { matches, rollup_matches: rollupMatches };
}

export const handleDeepSearch = async (
  client: RoamClient,
  query: string,
  searchTerms?: string[],
  skipLiveSearch?: boolean,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const allTerms = searchTerms ?? [];

  // 1. Search the index (instant)
  const index = await readPilotIndex();

  let indexSection: Record<string, unknown>;
  if (index) {
    const { matches, rollup_matches } = searchIndex(index, query, allTerms);
    indexSection = {
      has_index: true,
      last_indexed: index.indexed_at,
      total_pilots_indexed: Object.keys(index.pilots).length,
      matching_pilots: matches.length,
      pilots: matches,
      rollups:
        Object.keys(rollup_matches).length > 0 ? rollup_matches : undefined,
    };
  } else {
    indexSection = {
      has_index: false,
      note: "No index found. Run extract_pilot_data + save_pilot_index to build one.",
    };
  }

  // 2. Run live search (unless skipped)
  let liveSection: unknown;
  if (!skipLiveSearch) {
    const liveResult = await handleGetPilotSupport(client, query, allTerms);
    try {
      liveSection = JSON.parse(liveResult.content[0].text);
    } catch {
      liveSection = { error: "Failed to parse live search results" };
    }
  } else {
    liveSection = { skipped: true };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            query,
            search_terms: [query, ...allTerms],
            from_index: indexSection,
            from_live_search: liveSection,
          },
          null,
          2,
        ),
      },
    ],
  };
};
