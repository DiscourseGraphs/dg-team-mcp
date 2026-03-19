// Tool: get_node_section
// Query a specific section from a discourse node's page using its template structure.
// Discourse nodes have templates that define sections (e.g., "Summary::", "Evidence::").
// This tool reads the node's block tree and extracts the named section.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { getBasicTreeByParentUid } from "../roam.js";
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

const findSection = (
  tree: TreeNode[],
  sectionName: string,
): TreeNode | undefined => {
  const normalizedName = sectionName.toLowerCase().replace(/::$/, "");
  return tree.find((node) => {
    const nodeText = node.text.toLowerCase().replace(/::$/, "").trim();
    return nodeText === normalizedName || nodeText.startsWith(normalizedName + "::");
  });
};

export const handleGetNodeSection = async (
  client: RoamClient,
  uid: string,
  section: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const tree = await getBasicTreeByParentUid(client, uid);

  if (section === "*") {
    // Return all top-level sections with their content
    const sections = tree.map((node) => ({
      section: node.text,
      uid: node.uid,
      content: flattenTree(node.children),
      children_count: node.children.length,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ uid, sections }, null, 2) }],
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
          },
          null,
          2,
        ),
      },
    ],
  };
};
