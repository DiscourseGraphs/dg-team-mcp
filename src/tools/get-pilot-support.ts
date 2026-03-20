// Tool: get_pilot_support
// Layered search across pilot user pages for feature support.
// Level 1 — EXPLICIT: wikilink [[Feature]] references (Datalog block/refs)
// Level 2 — IMPLICIT: exact phrase or all-words match + sentiment co-occurrence
// Level 3 — TANGENTIAL: any-word match (words ≥4 chars)

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import {
  DEFAULT_TREE_DEPTH,
  datalogQuery,
  getBasicTreeByParentUidWithMeta,
} from "../roam.js";
import { getDiscourseNodeTypes } from "../discourse-config.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";
import type { TreeNode } from "../types.js";

export const GetPilotSupportSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  feature: z
    .string()
    .describe("The project or feature name to search for (e.g., 'Canvas', 'Left Sidebar')."),
  search_terms: z
    .array(z.string())
    .optional()
    .describe("Additional search terms or synonyms beyond the feature name."),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum child depth to fetch for each pilot page. Default ${DEFAULT_TREE_DEPTH}.`,
    ),
});

export const getPilotSupportDescription =
  "Layered search across every pilot user page for feature support. " +
  "Level 1 (explicit): [[Feature]] wikilink references — zero false positives. " +
  "Level 2 (implicit): exact phrase or all-words match with sentiment detection. " +
  "Level 3 (tangential): any-word match. Each block includes UID for source verification.";

const SENTIMENT_WORDS = [
  "need", "want", "love", "critical", "blocker", "excited", "useful",
  "essential", "requested", "important", "great", "amazing", "necessary",
  "crucial", "must", "require", "wish", "hope", "prefer", "missing",
  "would be nice", "looking forward", "can't wait", "deal breaker",
];

type ExplicitMention = { text: string; uid: string };
type ImplicitMention = {
  text: string;
  uid: string;
  parent_text: string;
  match_type: "exact_phrase" | "all_words";
  has_sentiment: boolean;
  sentiment_words: string[];
};
type TangentialMention = {
  text: string;
  uid: string;
  parent_text: string;
  matched_words: string[];
};

type PilotInfo = { uid: string; title: string };

// --- Helpers ---

const findSentiment = (text: string): string[] => {
  const lower = text.toLowerCase();
  return SENTIMENT_WORDS.filter((w) => lower.includes(w));
};

const countBlocks = (nodes: TreeNode[]): number =>
  nodes.reduce((sum, n) => sum + 1 + countBlocks(n.children), 0);

// Walk the tree and classify each block into levels
const classifyBlocks = (
  nodes: TreeNode[],
  featureLower: string,
  allWords: string[],
  anyWords: string[],
  parentText = "",
): {
  implicit: ImplicitMention[];
  tangential: TangentialMention[];
} => {
  const implicit: ImplicitMention[] = [];
  const tangential: TangentialMention[] = [];

  for (const node of nodes) {
    const blockLower = node.text.toLowerCase();

    // Level 2: exact phrase
    if (blockLower.includes(featureLower)) {
      const sentiment = findSentiment(blockLower);
      implicit.push({
        text: node.text,
        uid: node.uid,
        parent_text: parentText,
        match_type: "exact_phrase",
        has_sentiment: sentiment.length > 0,
        sentiment_words: sentiment,
      });
    }
    // Level 2: all words present (but not exact phrase — already caught above)
    else if (allWords.length > 1 && allWords.every((w) => blockLower.includes(w))) {
      const sentiment = findSentiment(blockLower);
      implicit.push({
        text: node.text,
        uid: node.uid,
        parent_text: parentText,
        match_type: "all_words",
        has_sentiment: sentiment.length > 0,
        sentiment_words: sentiment,
      });
    }
    // Level 3: any word (≥4 chars)
    else {
      const matched = anyWords.filter((w) => blockLower.includes(w));
      if (matched.length > 0) {
        tangential.push({
          text: node.text,
          uid: node.uid,
          parent_text: parentText,
          matched_words: matched,
        });
      }
    }

    // Recurse into children
    if (node.children.length) {
      const childResults = classifyBlocks(
        node.children,
        featureLower,
        allWords,
        anyWords,
        node.text,
      );
      implicit.push(...childResults.implicit);
      tangential.push(...childResults.tangential);
    }
  }

  return { implicit, tangential };
};

// --- Main handler ---

export const handleGetPilotSupport = async (
  client: RoamClient,
  feature: string,
  searchTerms?: string[],
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  // Build search terms
  const featureLower = feature.toLowerCase();
  const allTerms = [feature, ...(searchTerms ?? [])];
  const allWords = allTerms
    .flatMap((t) => t.toLowerCase().split(/\s+/))
    .filter(Boolean);
  const uniqueWords = [...new Set(allWords)];
  const anyWords = uniqueWords.filter((w) => w.length >= 4); // skip short/common words

  // 1. Find pilot user pages
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

  const pilots: PilotInfo[] = pilotResults
    .map((r) => ({ uid: r.uid, title: titleFromMarkdown(r.markdown) }))
    .filter((p) => !formatRegex || formatRegex.test(p.title));

  // 2. Level 1 — EXPLICIT: wikilink references (parallel Datalog per pilot)
  type ExplicitResult = { pilot: string; page_uid: string; mentions: ExplicitMention[] };
  const explicitResults: ExplicitResult[] = [];

  // Try all feature name variants as wikilink targets
  const featureVariants = [...new Set([feature, ...allTerms])];

  await Promise.all(
    pilots.map(async (pilot) => {
      const mentions: ExplicitMention[] = [];
      for (const variant of featureVariants) {
        const refs = await datalogQuery<[string, string]>(
          client,
          `[:find ?block-text ?block-uid
            :where
            [?feature-page :node/title "${variant.replace(/"/g, '\\"')}"]
            [?block :block/refs ?feature-page]
            [?block :block/page ?pilot-page]
            [?pilot-page :block/uid "${pilot.uid}"]
            [?block :block/string ?block-text]
            [?block :block/uid ?block-uid]]`,
        );
        refs
          .filter((r) => r != null && r[0] != null)
          .forEach(([text, uid]) => mentions.push({ text, uid }));
      }
      if (mentions.length > 0) {
        explicitResults.push({ pilot: pilot.title, page_uid: pilot.uid, mentions });
      }
    }),
  );

  // 3. Level 2 & 3 — Text search (fetch tree once per pilot, classify all blocks)
  type ImplicitResult = {
    pilot: string;
    page_uid: string;
    blocks_scanned: number;
    mentions: ImplicitMention[];
  };
  type TangentialResult = {
    pilot: string;
    page_uid: string;
    blocks_scanned: number;
    mentions: TangentialMention[];
  };
  const implicitResults: ImplicitResult[] = [];
  const tangentialResults: TangentialResult[] = [];
  const notFound: Array<{
    pilot: string;
    page_uid: string;
    blocks_scanned: number;
    depth_limited: boolean;
  }> = [];
  let totalBlocksScanned = 0;
  let truncatedPilotCount = 0;

  await Promise.all(
    pilots.map(async (pilot) => {
      const { tree, truncated } = await getBasicTreeByParentUidWithMeta(
        client,
        pilot.uid,
        maxDepth,
      );
      const scanned = countBlocks(tree);
      totalBlocksScanned += scanned;
      if (truncated) truncatedPilotCount += 1;

      const { implicit, tangential } = classifyBlocks(
        tree,
        featureLower,
        uniqueWords,
        anyWords,
      );

      const hasExplicit = explicitResults.some((e) => e.page_uid === pilot.uid);

      if (implicit.length > 0) {
        implicitResults.push({
          pilot: pilot.title,
          page_uid: pilot.uid,
          blocks_scanned: scanned,
          mentions: implicit,
        });
      }

      if (tangential.length > 0) {
        tangentialResults.push({
          pilot: pilot.title,
          page_uid: pilot.uid,
          blocks_scanned: scanned,
          mentions: tangential,
        });
      }

      if (!hasExplicit && implicit.length === 0 && tangential.length === 0) {
        notFound.push({
          pilot: pilot.title,
          page_uid: pilot.uid,
          blocks_scanned: scanned,
          depth_limited: truncated,
        });
      }
    }),
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            feature,
            search_terms: allTerms,
            search_method: "layered — wikilinks → exact/all-words+sentiment → any-word",
            pilots_searched: pilots.length,
            total_blocks_scanned: totalBlocksScanned,
            max_depth_used: maxDepth,
            truncated_pilot_count: truncatedPilotCount,

            explicit: {
              description: "Wikilink [[Feature]] references — strongest signal",
              count: explicitResults.length,
              pilots: explicitResults,
            },

            implicit: {
              description: "Exact phrase or all-words match, with sentiment detection",
              count: implicitResults.length,
              pilots: implicitResults,
            },

            tangential: {
              description: "Any search word (≥4 chars) found — weakest signal",
              count: tangentialResults.length,
              pilots: tangentialResults,
            },

            not_found: notFound,
          },
          null,
          2,
        ),
      },
    ],
  };
};
