// Tool: get_node_images
// Extract image URLs from a node's content tree.

// MODIFIED-START from loadImage.ts:extractFirstImageUrl
// — uses our getBasicTreeByParentUid instead of window.roamAlphaAPI
// — returns URLs instead of fetching/base64 encoding (caller can fetch if needed)
// — recursive tree traversal to find all images, not just first

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import {
  DEFAULT_TREE_DEPTH,
  getBasicTreeByParentUidWithMeta,
} from "../roam.js";
import type { TreeNode } from "../types.js";

export const GetNodeImagesSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The page/block UID to extract images from."),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum child depth to fetch. Default ${DEFAULT_TREE_DEPTH}. Increase for deeply nested pages.`,
    ),
});

export const getNodeImagesDescription =
  "Extract all image URLs from a node's content tree. Searches through " +
  "all child blocks for markdown image syntax (![...](url)) and returns " +
  "the URLs found.";

// COPY from loadImage.ts:extractFirstImageUrl (regex pattern)
const IMAGE_REGEX = /!\[.*?\]\((https?:\/\/[^)]+)\)/g;

const extractImageUrls = (text: string): string[] => {
  const urls: string[] = [];
  let match;
  while ((match = IMAGE_REGEX.exec(text)) !== null) {
    urls.push(match[1]);
  }
  IMAGE_REGEX.lastIndex = 0;
  return urls;
};

const findAllImages = (nodes: TreeNode[]): string[] => {
  const urls: string[] = [];
  for (const node of nodes) {
    urls.push(...extractImageUrls(node.text));
    if (node.children.length) {
      urls.push(...findAllImages(node.children));
    }
  }
  return urls;
};
// MODIFIED-END

export const handleGetNodeImages = async (
  client: RoamClient,
  uid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const { tree, truncated } = await getBasicTreeByParentUidWithMeta(
    client,
    uid,
    maxDepth,
  );
  const urls = findAllImages(tree);

  // Deduplicate
  const unique = [...new Set(urls)];

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            uid,
            image_count: unique.length,
            image_urls: unique,
            max_depth_used: maxDepth,
            depth_limited: truncated,
          },
          null,
          2,
        ),
      },
    ],
  };
};
