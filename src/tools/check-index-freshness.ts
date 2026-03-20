// Tool: check_index_freshness
// Compare stored page edit times against live Roam data.
// Reports stale, fresh, and unindexed pilots.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getPageEditTime } from "../roam.js";
import { readPilotIndex, INDEX_PATH } from "../pilot-index.js";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";

export const CheckIndexFreshnessSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
});

export const checkIndexFreshnessDescription =
  "Check if the pilot knowledge index is up to date. Compares stored page edit " +
  "times against current Roam data. Reports which pilots are stale (changed since " +
  "last index), fresh, or not yet indexed. Use before querying to decide if " +
  "re-indexing is needed.";

export const handleCheckIndexFreshness = async (
  client: RoamClient,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const index = await readPilotIndex();

  if (!index) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              has_index: false,
              suggestion:
                "No index found. Run extract_pilot_data and save_pilot_index to build one.",
              expected_path: INDEX_PATH,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Check freshness for each indexed pilot
  const stale: Array<{
    uid: string;
    name: string;
    indexed_edit_time: number;
    current_edit_time: number;
  }> = [];
  const fresh: Array<{ uid: string; name: string; last_indexed: string }> = [];

  await Promise.all(
    Object.entries(index.pilots).map(async ([uid, entry]) => {
      const currentEditTime = await getPageEditTime(client, uid);
      if (currentEditTime && currentEditTime > entry.page_edit_time) {
        stale.push({
          uid,
          name: entry.name,
          indexed_edit_time: entry.page_edit_time,
          current_edit_time: currentEditTime,
        });
      } else {
        fresh.push({
          uid,
          name: entry.name,
          last_indexed: entry.last_indexed,
        });
      }
    }),
  );

  // Find unindexed pilots (exist in graph but not in index)
  const config = await getDiscourseNodeTypes(client);
  const pilotNodeType = config.nodes.find(
    (n) =>
      n.name.toLowerCase() === "userpilot" ||
      n.name.toLowerCase() === "user pilot",
  );

  let unindexed: Array<{ uid: string; name: string }> = [];

  if (pilotNodeType) {
    type SearchResponse = {
      total: number;
      results: Array<{ uid: string; markdown: string }>;
    };

    const searchQuery = pilotNodeType.format
      ? pilotNodeType.format.split("{")[0].trim()
      : pilotNodeType.tag
        ? pilotNodeType.tag.replace(/^#/, "")
        : pilotNodeType.name;

    const response = await client.call<SearchResponse>("data.ai.search", [
      { query: searchQuery, scope: "pages", limit: 1000 },
    ]);
    const results = response.result?.results ?? [];

    const formatRegex = pilotNodeType.format
      ? getDiscourseNodeFormatExpression(pilotNodeType.format)
      : null;

    const titleFromMarkdown = (md: string): string => {
      const match = md.match(/^#\s+(.+?)(?:\s*<roam|$)/);
      return match?.[1] ?? md;
    };

    const allPilots = results
      .map((r) => ({ uid: r.uid, title: titleFromMarkdown(r.markdown) }))
      .filter((p) => !formatRegex || formatRegex.test(p.title));

    const indexedUids = new Set(Object.keys(index.pilots));
    unindexed = allPilots
      .filter((p) => !indexedUids.has(p.uid))
      .map((p) => ({ uid: p.uid, name: p.title }));
  }

  const recommendation =
    stale.length > 0
      ? `Re-index ${stale.length} stale pilot(s): ${stale.map((s) => s.name).join(", ")}`
      : unindexed.length > 0
        ? `Index ${unindexed.length} new pilot(s): ${unindexed.map((u) => u.name).join(", ")}`
        : "Index is up to date";

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            has_index: true,
            last_indexed: index.indexed_at,
            total_indexed: Object.keys(index.pilots).length,
            has_rollups: Object.keys(index.rollups).length > 0,
            stale: { count: stale.length, pilots: stale },
            fresh: { count: fresh.length, pilots: fresh },
            unindexed: { count: unindexed.length, pilots: unindexed },
            recommendation,
          },
          null,
          2,
        ),
      },
    ],
  };
};
