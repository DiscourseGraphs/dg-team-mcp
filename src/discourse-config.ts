// MODIFIED from:
// - apps/roam/src/utils/refreshConfigTree.ts (data fetching — replaced window.roamAlphaAPI with RoamClient)
// - apps/roam/src/utils/getDiscourseNodes.ts lines 105-177 (node parsing — parameterized)
// - apps/roam/src/utils/getDiscourseRelations.ts lines 34-61 (relation parsing — parameterized, takes tree instead of global ref)

import type { RoamClient } from "@roam-research/roam-tools-core";
import type {
  DiscourseNodeType,
  DiscourseRelationType,
  GetDiscourseNodeTypesResult,
  InternalDiscourseConfigResult,
  InternalDiscourseNodeType,
  InternalDiscourseRelationType,
  TreeNode,
} from "./types.js";
import {
  getConfigPageUid,
  getBasicTreeByParentUid,
  getNodePages,
} from "./roam.js";
import { getSettingValueFromTree, getSubTree, toFlexRegex } from "./tree-utils.js";
import { roamNodeToCondition } from "./query/parse-query.js";
import { DEFAULT_NODES, DEFAULT_RELATIONS } from "./defaults.js";

// MODIFIED-START from getDiscourseRelations.ts:34-61
// — takes configTree param instead of reading from discourseConfigRef global
// — returns DEFAULT_RELATIONS when no user config found
const parseRelations = (
  configTree: TreeNode[],
): InternalDiscourseRelationType[] => {
  const grammarNode = configTree.find((n) =>
    toFlexRegex("grammar").test(n.text),
  );
  const relationsNode = grammarNode?.children.find((n) =>
    toFlexRegex("relations").test(n.text),
  );

  if (!relationsNode?.children.length) {
    return DEFAULT_RELATIONS.map((r) => ({ ...r, triples: [...r.triples] }));
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

const getSpecification = (children: TreeNode[]): ReturnType<typeof roamNodeToCondition>[] => {
  const specificationNode = getSubTree(children, "specification");
  const scratchNode = getSubTree(specificationNode.children, "scratch");
  const conditionsNode = getSubTree(scratchNode.children, "conditions");
  return conditionsNode.children.map(roamNodeToCondition);
};

const getUidAndBooleanSetting = (tree: TreeNode[], text: string) => {
  const node = tree.find((t) => t.text === text);
  return {
    uid: node?.uid || "",
    value: !!node?.children?.length,
  };
};

// MODIFIED-START from getDiscourseNodes.ts:105-177
// — takes nodePages Map + relations as params instead of reading from discourseConfigRef
const parseNodes = (
  nodePages: Map<string, { text: string; children: TreeNode[] }>,
  relations: InternalDiscourseRelationType[],
): InternalDiscourseNodeType[] => {
  const configuredNodes: InternalDiscourseNodeType[] = Array.from(
    nodePages.entries(),
  ).map(([typeId, { text, children }]) => {
    const suggestiveRules = getSubTree(children, "Suggestive Rules");
    const embeddingBlockRef = getSubTree(
      suggestiveRules.children,
      "Embedding Block Ref",
    );

    return {
      name: text,
      typeId,
      format: getSettingValueFromTree(children, "format"),
      shortcut: getSettingValueFromTree(children, "shortcut"),
      tag: getSettingValueFromTree(children, "tag"),
      description: getSettingValueFromTree(children, "description"),
      canvasSettings: Object.fromEntries(
        getSubTree(children, "canvas").children.map(
          (c) => [c.text, c.children[0]?.text ?? ""] as const,
        ),
      ),
      graphOverview: children.some((c) => c.text === "Graph Overview"),
      backedBy: "user" as const,
      specification: getSpecification(children),
      template: getSubTree(children, "template").children,
      embeddingRef: embeddingBlockRef.children[0]?.text,
      embeddingRefUid: embeddingBlockRef.uid,
      isFirstChild: getUidAndBooleanSetting(
        suggestiveRules.children,
        "First Child",
      ),
    };
  });

  const relationNodes: InternalDiscourseNodeType[] = relations
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
      specification: r.triples.map(([source, relation, target], index) => ({
        type: "clause" as const,
        source: /anchor/i.test(source) ? r.label : source,
        relation,
        target:
          target === "source"
            ? r.source
            : target === "destination"
              ? r.destination
              : /anchor/i.test(target)
                ? r.label
                : target,
        uid: `${r.id}-relation-spec-${index}`,
      })),
      template: [],
    }));

  const allConfigured = configuredNodes.concat(relationNodes);

  // Add defaults (Page, Block) if not overridden
  const configuredNames = new Set(allConfigured.map((n) => n.name));
  const defaults = DEFAULT_NODES.filter((n) => !configuredNames.has(n.name));

  return allConfigured.concat(defaults);
};
// MODIFIED-END

const toPublicNodeType = ({
  specification: _specification,
  template: _template,
  embeddingRef: _embeddingRef,
  embeddingRefUid: _embeddingRefUid,
  isFirstChild: _isFirstChild,
  ...node
}: InternalDiscourseNodeType): DiscourseNodeType => node;

const dedupeRelations = (
  relations: InternalDiscourseRelationType[],
): DiscourseRelationType[] => {
  const seen = new Set<string>();
  return relations
    .map(({ triples: _triples, ...relation }) => relation)
    .filter((relation) => {
      const key = [
        relation.id,
        relation.label,
        relation.source,
        relation.destination,
        relation.complement,
      ].join("::");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export const getInternalDiscourseConfig = async (
  client: RoamClient,
): Promise<InternalDiscourseConfigResult> => {
  const nodePages = await getNodePages(client);
  const configUid = await getConfigPageUid(client);
  const configTree = configUid
    ? await getBasicTreeByParentUid(client, configUid)
    : [];
  const parsedRelations = parseRelations(configTree);
  const nodes = parseNodes(nodePages, parsedRelations);
  const configured = configUid !== undefined && nodePages.size > 0;
  return { configured, nodes, relations: parsedRelations };
};

export const getDiscourseNodeTypes = async (
  client: RoamClient,
): Promise<GetDiscourseNodeTypesResult> => {
  const internal = await getInternalDiscourseConfig(client);
  return {
    configured: internal.configured,
    nodes: internal.nodes.map(toPublicNodeType),
    relations: dedupeRelations(internal.relations),
  };
};
