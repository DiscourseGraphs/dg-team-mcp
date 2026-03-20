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

const DEFAULT_IMAGE_LIMIT = 3;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
  include_image_content: z
    .boolean()
    .optional()
    .describe(
      "When true, fetch the extracted image URLs and return actual MCP image content blocks so the client can inspect the images.",
    ),
  image_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum number of images to fetch and attach when include_image_content is true. Default ${DEFAULT_IMAGE_LIMIT}.`,
    ),
  max_image_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum size per fetched image in bytes. Default ${DEFAULT_MAX_IMAGE_BYTES}.`,
    ),
});

export const getNodeImagesDescription =
  "Extract all image URLs from a node's content tree. Searches through " +
  "all child blocks for markdown image syntax (![...](url)) and returns " +
  "the URLs found. Optionally fetches those images and returns actual MCP " +
  "image content blocks so vision-capable clients can inspect them.";

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

const inferMimeTypeFromUrl = (url: string): string | null => {
  const lower = url.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return null;
};

const parseDataUriImage = (url: string): { mimeType: string; data: string } | null => {
  const match = /^data:(image\/[^;]+);base64,(.+)$/i.exec(url);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
};

const fetchImageContent = async ({
  url,
  maxImageBytes,
}: {
  url: string;
  maxImageBytes: number;
}): Promise<
  | { ok: true; content: { type: "image"; data: string; mimeType: string } }
  | { ok: false; reason: string }
> => {
  const dataUriImage = parseDataUriImage(url);
  if (dataUriImage) {
    return {
      ok: true,
      content: {
        type: "image",
        mimeType: dataUriImage.mimeType,
        data: dataUriImage.data,
      },
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }

  const mimeType =
    response.headers.get("content-type")?.split(";")[0].trim() ||
    inferMimeTypeFromUrl(url);
  if (!mimeType || !mimeType.startsWith("image/")) {
    return {
      ok: false,
      reason: `Unsupported content type: ${mimeType || "unknown"}`,
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxImageBytes) {
    return {
      ok: false,
      reason: `Image too large (${arrayBuffer.byteLength} bytes)`,
    };
  }

  return {
    ok: true,
    content: {
      type: "image",
      mimeType,
      data: Buffer.from(arrayBuffer).toString("base64"),
    },
  };
};
// MODIFIED-END

export const handleGetNodeImages = async (
  client: RoamClient,
  uid: string,
  maxDepth = DEFAULT_TREE_DEPTH,
  includeImageContent = false,
  imageLimit = DEFAULT_IMAGE_LIMIT,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
): Promise<{ content: ToolContent[]; isError?: boolean }> => {
  const { tree, truncated } = await getBasicTreeByParentUidWithMeta(
    client,
    uid,
    maxDepth,
  );
  const urls = findAllImages(tree);

  // Deduplicate
  const unique = [...new Set(urls)];

  const attachedImages: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const fetchErrors: Array<{ url: string; reason: string }> = [];

  if (includeImageContent) {
    for (const url of unique.slice(0, imageLimit)) {
      try {
        const result = await fetchImageContent({ url, maxImageBytes });
        if (result.ok) {
          attachedImages.push(result.content);
        } else {
          fetchErrors.push({ url, reason: result.reason });
        }
      } catch (error) {
        fetchErrors.push({
          url,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

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
            image_content_requested: includeImageContent,
            attached_image_count: attachedImages.length,
            image_limit: includeImageContent ? imageLimit : undefined,
            max_image_bytes: includeImageContent ? maxImageBytes : undefined,
            image_fetch_errors: fetchErrors,
          },
          null,
          2,
        ),
      },
      ...attachedImages,
    ],
  };
};
