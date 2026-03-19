// MODIFIED from:
// - apps/roam/src/utils/refreshConfigTree.ts (data fetching — replaced window.roamAlphaAPI with RoamClient)
// - apps/roam/src/utils/getDiscourseNodes.ts lines 105-177 (node parsing — parameterized, removed spec/template/suggestive fields)
// - apps/roam/src/utils/getDiscourseRelations.ts lines 34-61 (relation parsing — parameterized, takes tree instead of global ref)

import type { RoamClient } from "@roam-research/roam-tools-core";
import type {
  DiscourseNodeType,
  DiscourseRelationType,
  GetDiscourseNodeTypesResult,
  TreeNode,
} from "./types.js";
import {
  getConfigPageUid,
  getBasicTreeByParentUid,
  getNodePages,
} from "./roam.js";
import { getSettingValueFromTree, getSubTree, toFlexRegex } from "./tree-utils.js";
import { DEFAULT_NODES, DEFAULT_RELATIONS } from "./defaults.js";

interface ParsedRelation extends DiscourseRelationType {
  triples: readonly [string, string, string][];
}

// MODIFIED-START from getDiscourseRelations.ts:34-61
// — takes configTree param instead of reading from discourseConfigRef global
// — returns DEFAULT_RELATIONS when no user config found
const parseRelations = (configTree: TreeNode[]): ParsedRelation[] => {
  const grammarNode = configTree.find((n) =>
    toFlexRegex("grammar").test(n.text),
  );
  const relationsNode = grammarNode?.children.find((n) =>
    toFlexRegex("relations").test(n.text),
  );

  if (!relationsNode?.children.length) {
    // No user-configured relations — return defaults (without triples since we
    // only extracted metadata; relation-backed nodes won't be generated from defaults)
    return DEFAULT_RELATIONS.map((r) => ({ ...r, triples: [] }));
  }

  return relationsNode.children.flatMap((r, i) => {
    const tree = r.children;
    const data = {
      id: r.uid || `${r.text}-${i}`,
      label: r.text,
      source: getSettingValueFromTree(tree, "Source"),
      destination: getSettingValueFromTree(tree, "Destination"),
      complement: getSettingValueFromTree(tree, "Complement"),
    };

    const ifNode =
      tree.find((t) => toFlexRegex("if").test(t.text))?.children ?? [];

    return ifNode.map((node) => ({
      ...data,
      triples: node.children
        .filter((t) => !/node positions/i.test(t.text))
        .map(
          (t) =>
            [
              t.text,
              t.children[0]?.text ?? "",
              t.children[0]?.children?.[0]?.text ?? "",
            ] as const,
        ),
    }));
  });
};
// MODIFIED-END

// MODIFIED-START from getDiscourseNodes.ts:105-177
// — takes nodePages Map + relations as params instead of reading from discourseConfigRef
// — removed specification, template, embeddingRef, isFirstChild fields (internal to extension)
const parseNodes = (
  nodePages: Map<string, { text: string; children: TreeNode[] }>,
  relations: ParsedRelation[],
): DiscourseNodeType[] => {
  // User-configured nodes from "discourse-graph/nodes/*" pages
  // COPY from getDiscourseNodes.ts:106-143 (settings extraction pattern)
  const configuredNodes: DiscourseNodeType[] = Array.from(
    nodePages.entries(),
  ).map(([typeId, { text, children }]) => ({
    name: text,
    typeId,
    format: getSettingValueFromTree(children, "format"),
    shortcut: getSettingValueFromTree(children, "shortcut"),
    tag: getSettingValueFromTree(children, "tag"),
    description: getSettingValueFromTree(children, "description"),
    // COPY from getDiscourseNodes.ts:125-128 — full canvas settings map
    canvasSettings: Object.fromEntries(
      getSubTree(children, "canvas").children.map(
        (c) => [c.text, c.children[0]?.text ?? ""] as const,
      ),
    ),
    graphOverview: children.some((c) => c.text === "Graph Overview"),
    backedBy: "user" as const,
  }));

  // Relation-backed nodes (those with "anchor" in triples)
  // From getDiscourseNodes.ts:145-171
  const relationNodes: DiscourseNodeType[] = relations
    .filter((r) =>
      r.triples.some((t) => t.some((n) => /anchor/i.test(n))),
    )
    .map((r) => ({
      name: r.label,
      typeId: r.id,
      format: "",
      shortcut: r.label.slice(0, 1),
      tag: "",
      description: "",
      canvasSettings: {},
      graphOverview: false,
      backedBy: "relation" as const,
    }));

  const allConfigured = configuredNodes.concat(relationNodes);

  // Add defaults (Page, Block) if not overridden
  const configuredNames = new Set(allConfigured.map((n) => n.name));
  const defaults = DEFAULT_NODES.filter((n) => !configuredNames.has(n.name));

  return allConfigured.concat(defaults);
};
// MODIFIED-END

export const getDiscourseNodeTypes = async (
  client: RoamClient,
): Promise<GetDiscourseNodeTypesResult> => {
  // 1. Fetch node type pages (same as refreshConfigTree.ts:27-37)
  const nodePages = await getNodePages(client);

  // 2. Fetch config page tree for relations
  const configUid = await getConfigPageUid(client);
  const configTree = configUid
    ? await getBasicTreeByParentUid(client, configUid)
    : [];

  // 3. Parse relations from grammar > relations subtree
  const parsedRelations = parseRelations(configTree);

  // 4. Parse nodes from node pages + relation-backed nodes + defaults
  const nodes = parseNodes(nodePages, parsedRelations);

  // 5. Return output (strip triples from relations — internal detail)
  const relations = parsedRelations.map(
    ({ triples, ...rest }) => rest,
  );

  const configured = configUid !== undefined && nodePages.size > 0;

  return { configured, nodes, relations };
};
