// Tool: index_pilot_pages
// User-facing entry point for building the pilot knowledge index.
// Auto-discovers all pilots and paginates through them in batches.
// Claude classifies each batch, saves via save_pilot_index, then
// calls this tool again with the next offset until done.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getBasicTreeByParentUid, getPageEditTime } from "../roam.js";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";
import type { TreeNode } from "../types.js";

export const IndexPilotPagesSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  batch_size: z
    .number()
    .optional()
    .describe("Number of pilots per batch. Default 5. Lower if responses are too large."),
  offset: z
    .number()
    .optional()
    .describe("Starting position in the pilot list. Default 0. Increment by batch_size to continue."),
});

export const indexPilotPagesDescription =
  "Build or update the pilot knowledge index. Auto-discovers all pilot pages and " +
  "returns them in batches, chunked by section headings. After receiving each batch: " +
  "(1) classify each pilot's content into topics (feature_requests, pain_points, " +
  "workflow, feedback, challenges, interests, etc.), " +
  "(2) call save_pilot_index with the classifications, " +
  "(3) call index_pilot_pages again with the next offset until has_more is false. " +
  "After all batches, generate cross-pilot rollups and save those too.";

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

export const handleIndexPilotPages = async (
  client: RoamClient,
  batchSize = 5,
  offset = 0,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // 1. Discover all pilot pages
  const config = await getDiscourseNodeTypes(client);
  const pilotNodeType = config.nodes.find(
    (n) =>
      n.name.toLowerCase() === "userpilot" ||
      n.name.toLowerCase() === "user pilot",
  );

  if (!pilotNodeType) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "No UserPilot node type found",
              available_types: config.nodes.map((n) => n.name),
            },
            null,
            2,
          ),
        },
      ],
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
    .filter((p) => !formatRegex || formatRegex.test(p.title))
    .sort((a, b) => a.title.localeCompare(b.title));

  const totalPilots = allPilots.length;

  if (totalPilots === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "No pilot pages found in graph" },
            null,
            2,
          ),
        },
      ],
    };
  }

  // 2. Slice the current batch
  const batch = allPilots.slice(offset, offset + batchSize);

  if (batch.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              done: true,
              total_pilots: totalPilots,
              message:
                "All pilots have been extracted. Generate cross-pilot rollups " +
                "now and save them with save_pilot_index.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // 3. Extract each pilot in this batch
  const pilots = await Promise.all(
    batch.map(async (pilot) => {
      const [tree, editTime] = await Promise.all([
        getBasicTreeByParentUid(client, pilot.uid),
        getPageEditTime(client, pilot.uid),
      ]);

      const totalBlocks = countBlocks(tree);

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

  const nextOffset = offset + batchSize;
  const hasMore = nextOffset < totalPilots;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            batch_number: Math.floor(offset / batchSize) + 1,
            total_batches: Math.ceil(totalPilots / batchSize),
            offset,
            batch_size: batchSize,
            total_pilots: totalPilots,
            pilots_in_batch: pilots.length,
            has_more: hasMore,
            next_offset: hasMore ? nextOffset : undefined,
            pilots,
          },
          null,
          2,
        ),
      },
    ],
  };
};
