// MODIFIED from apps/roam/src/utils/parseQuery.ts
// — Uses our TreeNode type instead of RoamBasicNode
// — Removed getSubTree with parentUid (creates blocks in Roam)
// — Removed createBlock / generateUID calls (write operations)
// — Takes a TreeNode (pre-fetched block tree) instead of a parentUid string

import type { TreeNode } from "../types.js";
import type { Condition, Selection, Column } from "./types.js";
import { getSettingValueFromTree, getSubTree } from "../tree-utils.js";

// COPY-START from parseQuery.ts:7-40 (roamNodeToCondition)
export const roamNodeToCondition = ({
  uid,
  children,
  text,
}: TreeNode): Condition => {
  const type = (
    isNaN(Number(text))
      ? text
      : !!getSubTree(children, "not").uid
        ? "not"
        : "clause"
  ) as Condition["type"];
  return type === "clause" || type === "not"
    ? {
        uid,
        source: getSettingValueFromTree(children, "source"),
        target: getSettingValueFromTree(children, "target"),
        relation: getSettingValueFromTree(children, "relation"),
        type,
        not: type === "not" || !!getSubTree(children, "not").uid,
      }
    : {
        uid,
        type,
        conditions: children.map((node) =>
          node.children.map(roamNodeToCondition),
        ),
      };
};
// COPY-END

export const DEFAULT_RETURN_NODE = "node";

// MODIFIED-START from parseQuery.ts:57-115
// — Takes a TreeNode (the scratch node's tree) instead of a parentUid string
// — Removed getOrCreateUid (no block creation in MCP)
export const parseQuery = (scratchTree: TreeNode) => {
  const { children } = scratchTree;

  const conditionsNode = getSubTree(children, "conditions");
  const conditions = conditionsNode.children.map(roamNodeToCondition);

  const selectionsNode = getSubTree(children, "selections");
  const selections: Selection[] = selectionsNode.children.map(
    ({ uid, text, children: ch }) => ({
      uid,
      text,
      label: ch?.[0]?.text || "",
    }),
  );

  const customBlock = getSubTree(children, "custom");
  const returnNodeUid = "returnuid";

  return {
    returnNode: DEFAULT_RETURN_NODE,
    conditions,
    selections,
    customNode: customBlock.children[0]?.text || "",
    returnNodeUid,
    conditionsNodesUid: conditionsNode.uid,
    selectionsNodesUid: selectionsNode.uid,
    customNodeUid: customBlock.uid,
    isCustomEnabled: customBlock.children[1]?.text === "enabled",
    columns: [
      {
        key:
          selections.find((s) => s.text === DEFAULT_RETURN_NODE)?.label ||
          "text",
        uid: returnNodeUid,
        selection: DEFAULT_RETURN_NODE,
      } as Column,
    ].concat(
      selections
        .filter((s) => s.text !== DEFAULT_RETURN_NODE)
        .map((s) => ({ uid: s.uid, key: s.label, selection: s.text })),
    ),
  };
};
// MODIFIED-END

export default parseQuery;
