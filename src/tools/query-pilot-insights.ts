// Tool: query_pilot_insights
// Read from the pilot knowledge index. Instant — no Roam API calls.
// Filter by pilot, topic, or both. Use summary_only for quick overviews.

import { z } from "zod";
import { readPilotIndex, INDEX_PATH } from "../pilot-index.js";

export const QueryPilotInsightsSchema = z.object({
  pilot_uid: z
    .string()
    .optional()
    .describe("Filter to a specific pilot by page UID."),
  topic: z
    .string()
    .optional()
    .describe(
      "Filter to a specific topic (e.g., 'feature_requests', 'pain_points', 'workflow').",
    ),
  summary_only: z
    .boolean()
    .optional()
    .describe(
      "If true, return only summaries without individual block items. Faster to scan.",
    ),
});

export const queryPilotInsightsDescription =
  "Query the pilot knowledge index for cached insights. Returns instantly from " +
  "pre-indexed data. Filter by pilot_uid, topic, or both. Use summary_only for " +
  "quick overviews. If no index exists, suggests running extract_pilot_data first.";

export const handleQueryPilotInsights = async (
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const parsed = QueryPilotInsightsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "Invalid input", details: parsed.error.issues },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const { pilot_uid, topic, summary_only } = parsed.data;

  const index = await readPilotIndex();
  if (!index) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "No pilot index found",
              suggestion:
                "Run extract_pilot_data to extract pilot pages, classify them, " +
                "then save_pilot_index to build the index.",
              expected_path: INDEX_PATH,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Filter pilots
  let pilots = Object.entries(index.pilots);
  if (pilot_uid) {
    pilots = pilots.filter(([uid]) => uid === pilot_uid);
    if (pilots.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Pilot ${pilot_uid} not found in index`,
                indexed_pilots: Object.entries(index.pilots).map(
                  ([uid, p]) => ({ uid, name: p.name }),
                ),
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  }

  // Build pilot results with optional topic filter and summary mode
  const pilotResults = pilots.map(([uid, entry]) => {
    let topics = Object.entries(entry.topics);
    if (topic) {
      topics = topics.filter(([key]) => key === topic);
    }

    const topicData = Object.fromEntries(
      topics.map(([key, t]) => [
        key,
        summary_only
          ? { summary: t.summary, item_count: t.items.length }
          : t,
      ]),
    );

    return {
      uid,
      name: entry.name,
      last_indexed: entry.last_indexed,
      profile: entry.profile,
      topics: topicData,
    };
  });

  // Include rollups when not filtering to a single pilot
  let rollups: Record<string, unknown> | undefined;
  if (!pilot_uid) {
    if (topic) {
      const filtered = index.rollups[topic];
      if (filtered) {
        rollups = { [topic]: filtered };
      }
    } else if (Object.keys(index.rollups).length > 0) {
      rollups = index.rollups;
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            index_version: index.version,
            last_indexed: index.indexed_at,
            total_pilots_indexed: Object.keys(index.pilots).length,
            showing: pilotResults.length,
            pilots: pilotResults,
            rollups,
          },
          null,
          2,
        ),
      },
    ],
  };
};
