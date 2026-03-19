// Tool: catch_me_up
// Comprehensive view of a user's discourse graph activity over a time period.
//
// Strategy: broad search, then organize.
// 1. Find ALL blocks created by the user in the period (across every page)
// 2. Find ALL blocks edited by the user in the period
// 3. Group by page, include actual block text
// 4. Detect which pages are discourse nodes (and what type)
// 5. For discourse node pages, include which template section each block is under
// 6. Separate daily notes from discourse work from other pages
// 7. Return chronological, detailed, breadcrumb-style data

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";

export const CatchMeUpSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  author: z
    .string()
    .describe(
      "The exact display name of the user (use get_users first to resolve partial names).",
    ),
  days: z
    .number()
    .optional()
    .default(7)
    .describe("Number of days to look back. Default 7."),
});

export const catchMeUpDescription =
  "Get a comprehensive, detailed view of a user's recent activity across the " +
  "entire discourse graph. Searches ALL pages the user touched — not just their " +
  "home page. Returns actual block content organized by page, with discourse " +
  "node type detection and chronological ordering. Use get_users first to " +
  "resolve the exact display name.";

type RawBlock = {
  text: string;
  uid: string;
  created: number;
  page_title: string;
  page_uid: string;
  author: string;
  parent_text: string;
  parent_uid: string;
};
type RawBlockTuple = [string, string, number, string, string, string, string, string];

type PageGroup = {
  page_title: string;
  page_uid: string;
  node_type: string | null;
  is_daily_note: boolean;
  block_count: number;
  earliest: number;
  latest: number;
  blocks: Array<{
    text: string;
    uid: string;
    created: number;
    parent_text: string;
  }>;
};

export const handleCatchMeUp = async (
  client: RoamClient,
  author: string,
  days = 7,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  // 1. Get ALL blocks created by ANY user since the timestamp,
  //    with parent block for breadcrumb context.
  //    Filter by author in JS (Roam Datalog doesn't support case-insensitive matching).
  const rawBlocks = await datalogQuery<RawBlockTuple>(
    client,
    `[:find ?text ?uid ?created ?page-title ?page-uid ?author-name ?parent-text ?parent-uid
      :where
      [?block :block/string ?text]
      [?block :block/uid ?uid]
      [?block :create/time ?created]
      [(> ?created ${sinceMs})]
      [?block :create/user ?user-eid]
      [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author-name]
      [?block :block/page ?page]
      [?page :node/title ?page-title]
      [?page :block/uid ?page-uid]
      [(get-else $ ?block :block/parents ?block) ?parent]
      [?parent :block/string ?parent-text]
      [?parent :block/uid ?parent-uid]
    ]`,
  );
  const allBlocks = rawBlocks
    .filter((r) => r != null)
    .map(([text, uid, created, page_title, page_uid, author, parent_text, parent_uid]) => ({
      text, uid, created, page_title, page_uid, author, parent_text, parent_uid,
    }));

  const authorLower = author.toLowerCase();
  const userBlocks = allBlocks
    .filter((b) =>
      (b.author || "").toLowerCase().includes(authorLower),
    );

  // 2. Detect daily note pages (have :log/id)
  const dailyNoteUids = await datalogQuery<[string]>(
    client,
    `[:find ?uid :where [?page :log/id _] [?page :block/uid ?uid]]`,
  );
  const dailyUidSet = new Set(dailyNoteUids.map((r) => r[0]));

  // 3. Get discourse node types for type detection
  const config = await getDiscourseNodeTypes(client);
  const nodeTypeMatchers = config.nodes
    .filter((n) => n.format && n.backedBy === "user")
    .map((n) => ({
      name: n.name,
      regex: getDiscourseNodeFormatExpression(n.format),
    }));

  const detectNodeType = (title: string): string | null => {
    for (const { name, regex } of nodeTypeMatchers) {
      if (regex.test(title)) return name;
    }
    return null;
  };

  // 4. Group blocks by page
  const pageMap = new Map<string, PageGroup>();
  userBlocks.forEach((b) => {
    let group = pageMap.get(b.page_uid);
    if (!group) {
      group = {
        page_title: b.page_title,
        page_uid: b.page_uid,
        node_type: detectNodeType(b.page_title),
        is_daily_note: dailyUidSet.has(b.page_uid),
        block_count: 0,
        earliest: b.created,
        latest: b.created,
        blocks: [],
      };
      pageMap.set(b.page_uid, group);
    }
    group.block_count++;
    group.earliest = Math.min(group.earliest, b.created);
    group.latest = Math.max(group.latest, b.created);
    group.blocks.push({
      text: b.text,
      uid: b.uid,
      created: b.created,
      parent_text: b.parent_text,
    });
  });

  // 5. Sort blocks within each page chronologically
  for (const group of pageMap.values()) {
    group.blocks.sort((a, b) => a.created - b.created);
  }

  // 6. Separate into categories
  const allPages = Array.from(pageMap.values());
  const dailyNotes = allPages
    .filter((p) => p.is_daily_note)
    .sort((a, b) => b.latest - a.latest);
  const discourseNodes = allPages
    .filter((p) => p.node_type !== null && !p.is_daily_note)
    .sort((a, b) => b.latest - a.latest);
  const otherPages = allPages
    .filter((p) => p.node_type === null && !p.is_daily_note)
    .sort((a, b) => b.latest - a.latest);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            author,
            period: `last ${days} days`,
            since: new Date(sinceMs).toISOString(),
            summary: {
              total_blocks_written: userBlocks.length,
              total_pages_touched: allPages.length,
              discourse_nodes_touched: discourseNodes.length,
              daily_note_pages: dailyNotes.length,
              other_pages: otherPages.length,
            },
            // Discourse nodes touched — with type, block content, and parent breadcrumbs
            discourse_work: discourseNodes,
            // Daily note entries — with full text
            daily_notes: dailyNotes,
            // Other pages (non-discourse, non-daily)
            other_work: otherPages,
          },
          null,
          2,
        ),
      },
    ],
  };
};
