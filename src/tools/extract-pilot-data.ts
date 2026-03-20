// Tool: extract_pilot_data
// Fetch pilot page content chunked by top-level sections for knowledge indexing.
// Returns blocks organized by section heading with UIDs for citation.
// Designed for batched use: call with 3-5 pilot_uids at a time.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getBasicTreeByParentUid, getPageEditTime } from "../roam.js";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";
import type { TreeNode } from "../types.js";

export const ExtractPilotDataSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  pilot_uids: z
    .array(z.string())
    .optional()
    .describe(
      "Specific pilot page UIDs to extract. Recommended: 3-5 per batch to fit " +
      "in context window. Call get_pilot_users first to discover all pilot UIDs.",
    ),
});

export const extractPilotDataDescription =
  "Extract pilot page content chunked by top-level sections for knowledge indexing. " +
  "Returns blocks organized by section heading with UIDs for citation. " +
  "Batch with pilot_uids (3-5 per call). After reading the output, classify each " +
  "pilot's content into topics (feature_requests, pain_points, workflow, feedback, " +
  "challenges, etc.) and save with save_pilot_index.";

interface FlatBlock {
  uid: string;
  text: string;
  depth: number;
}

function flattenTree(nodes: TreeNode[], depth = 0): FlatBlock[] {
  const result: FlatBlock[] = [];
  for (const node of nodes) {
    result.push({ uid: node.uid, text: node.text, depth });
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  return result;
}

function countBlocks(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countBlocks(n.children), 0);
}

export const handleExtractPilotData = async (
  client: RoamClient,
  pilotUids?: string[],
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // 1. Discover pilot pages
  const config = await getDiscourseNodeTypes(client);
  const pilotNodeType = config.nodes.find(
    (n) => n.name.toLowerCase() === "userpilot" || n.name.toLowerCase() === "user pilot",
  );

  if (!pilotNodeType) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "No UserPilot node type found",
          available_types: config.nodes.map((n) => n.name),
        }, null, 2),
      }],
    };
  }

  type SearchResponse = {
    total: number;
    results: Array<{ uid: string; markdown: string }>;
  };

  const searchQuery = pilotNodeType.format
    ? pilotNodeType.format.split("{")[0].trim()
    : pilotNodeType.tag
      ? pilotNodeType.tag.replace(/^#/, "")
      : pilotNodeType.name;

  const pilotResponse = await client.call<SearchResponse>("data.ai.search", [
    { query: searchQuery, scope: "pages", limit: 1000 },
  ]);
  const pilotResults = pilotResponse.result?.results ?? [];

  const formatRegex = pilotNodeType.format
    ? getDiscourseNodeFormatExpression(pilotNodeType.format)
    : null;

  const titleFromMarkdown = (md: string): string => {
    const match = md.match(/^#\s+(.+?)(?:\s*<roam|$)/);
    return match?.[1] ?? md;
  };

  const allPilots = pilotResults
    .map((r) => ({ uid: r.uid, title: titleFromMarkdown(r.markdown) }))
    .filter((p) => !formatRegex || formatRegex.test(p.title));

  // Filter to requested UIDs if provided
  const targetPilots = pilotUids?.length
    ? allPilots.filter((p) => pilotUids.includes(p.uid))
    : allPilots;

  if (targetPilots.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: pilotUids
            ? `No pilots found matching UIDs: ${pilotUids.join(", ")}`
            : "No pilot pages found in graph",
          total_pilots_available: allPilots.length,
        }, null, 2),
      }],
    };
  }

  // 2. Extract each pilot's tree + edit time
  const pilots = await Promise.all(
    targetPilots.map(async (pilot) => {
      const [tree, editTime] = await Promise.all([
        getBasicTreeByParentUid(client, pilot.uid),
        getPageEditTime(client, pilot.uid),
      ]);

      const totalBlocks = countBlocks(tree);

      // Chunk by top-level sections (direct children of page root)
      const sections = tree.map((topLevel) => {
        const blocks = flattenTree(topLevel.children);
        return {
          heading: topLevel.text,
          uid: topLevel.uid,
          block_count: 1 + blocks.length,
          blocks,
        };
      });

      return {
        name: pilot.title,
        uid: pilot.uid,
        page_edit_time: editTime,
        total_blocks: totalBlocks,
        sections,
      };
    }),
  );

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        extracted_count: pilots.length,
        total_pilots_available: allPilots.length,
        pilots,
      }, null, 2),
    }],
  };
};
