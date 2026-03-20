// Tool: get_node_section
// Query a specific section from a discourse node's page using its template structure.
// Discourse nodes have templates that define sections (e.g., "Summary::", "Evidence::").
// This tool reads the node's block tree and extracts the named section.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import {
  DEFAULT_TREE_DEPTH,
  getBasicTreeByParentUidWithMeta,
} from "../roam.js";
import type { TreeNode } from "../types.js";

export const GetNodeSectionSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  uid: z.string().describe("The page UID of the discourse node."),
  section: z
    .string()
    .describe(
      "The section name to extract (e.g., 'Summary', 'Evidence', 'Lab Notes'). " +
      "Matches case-insensitively. Handles Roam attribute syntax (with or without '::').",
    ),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum child depth to fetch. Default ${DEFAULT_TREE_DEPTH}. Increase for deeply nested pages.`,
    ),
});

export const getNodeSectionDescription =
  "Extract a specific section from a discourse node's page. Discourse nodes " +
  "are created with templates that define sections (e.g., 'Summary::', " +
  "'Evidence::', 'Lab Notes::'). This tool finds the matching section block " +
  "and returns its content tree. If section is omitted or '*', returns all sections.";

const flattenTree = (nodes: TreeNode[], depth = 0): string =>
  nodes
    .map(
      (n) =>
        `${"  ".repeat(depth)}- ${n.text}${
          n.children.length ? "\n" + flattenTree(n.children, depth + 1) : ""
        }`,
    )
    .join("\n");

const stripMarkup = (text: string): string =>
  text
    .replace(/\{\{[^}]*\}\}/g, "")   // {{buttons}}, {{SmartBlocks}}
    .replace(/#\.\S+/g, "")           // #.class tags
    .replace(/\*\*/g, "")             // bold
    .replace(/__/g, "")               // italic
    .replace(/^##?\s*/, "")           // heading markers
    .trim();

const findSection = (
  tree: TreeNode[],
  sectionName: string,
): TreeNode | undefined => {
  const normalizedName = sectionName.toLowerCase().replace(/::$/, "").trim();
  return tree.find((node) => {
    const nodeText = stripMarkup(node.text).toLowerCase().replace(/::$/, "").trim();
    return (
      nodeText === normalizedName ||
      nodeText.startsWith(normalizedName + "::") ||
      nodeText.startsWith(normalizedName + " ")
    );
  });
};

export const handleGetNodeSection = async (
  client: RoamClient,
  uid: string,
  section: string,
  maxDepth = DEFAULT_TREE_DEPTH,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const { tree, truncated } = await getBasicTreeByParentUidWithMeta(
    client,
    uid,
    maxDepth,
  );

  if (section === "*") {
    // Return all top-level sections with their content
    const sections = tree.map((node) => ({
      section: node.text,
      uid: node.uid,
      content: flattenTree(node.children),
      children_count: node.children.length,
      max_depth_used: maxDepth,
      depth_limited: truncated,
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              uid,
              max_depth_used: maxDepth,
              depth_limited: truncated,
              sections,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const sectionNode = findSection(tree, section);

  if (!sectionNode) {
    // List available sections to help the caller
    const available = tree.map((n) => n.text).filter(Boolean);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              uid,
              error: `Section "${section}" not found`,
              available_sections: available,
              max_depth_used: maxDepth,
              depth_limited: truncated,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            uid,
            section: sectionNode.text,
            section_uid: sectionNode.uid,
            content: flattenTree(sectionNode.children),
            children_count: sectionNode.children.length,
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
