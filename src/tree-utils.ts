// MODIFIED from roamjs-components — pure functions, no browser deps.
// Cannot import directly: roamjs-components versions import
// getBasicTreeByParentUid and createBlock at the top level, which crash
// in Node.js (they need window.roamAlphaAPI).

import type { TreeNode } from "./types.js";

// COPY-START from roamjs-components/util/toFlexRegex.ts
export const toFlexRegex = (key: string) =>
  new RegExp(
    `^\\s*${key.replace(/([()])/g, "\\$1")}\\s*(#\\.[\\w\\d-]*\\s*)?$`,
    "i",
  );
// COPY-END

// MODIFIED-START from roamjs-components/util/getSettingValueFromTree.ts
// — removed parentUid param and getBasicTreeByParentUid fallback (browser dep)
export const getSettingValueFromTree = (
  tree: TreeNode[],
  key: string,
  defaultValue = "",
): string => {
  const node = tree.find((s) => toFlexRegex(key).test(s.text.trim()));
  return node?.children[0]?.text.trim() ?? defaultValue;
};
// MODIFIED-END

// MODIFIED-START from roamjs-components/util/getSubTree.ts
// — removed parentUid param, createBlock call, and generateUID call (browser deps)
export const getSubTree = (tree: TreeNode[], key: string): TreeNode =>
  tree.find((s) => toFlexRegex(key).test(s.text.trim())) ?? {
    uid: "",
    text: "",
    children: [],
  };
// MODIFIED-END
