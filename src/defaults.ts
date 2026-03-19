// COPY from apps/roam/src/utils/getDiscourseNodes.ts:37-74 (default nodes)
// COPY from apps/roam/src/data/defaultDiscourseRelations.ts (relation metadata only)
// MODIFIED: removed specification/template fields (internal to extension),
// replaced canvasSettings with our output shape, hardcoded relation metadata
// instead of full triple/condition trees.

import type { DiscourseNodeType, DiscourseRelationType } from "./types.js";

export const DEFAULT_NODES: DiscourseNodeType[] = [
  {
    name: "Page",
    typeId: "page-node",
    format: "{content}",
    shortcut: "p",
    tag: "",
    description: "",
    canvasSettings: { color: "#000000" },
    graphOverview: false,
    backedBy: "default",
  },
  {
    name: "Block",
    typeId: "blck-node",
    format: "{content}",
    shortcut: "b",
    tag: "",
    description: "",
    canvasSettings: { color: "#505050" },
    graphOverview: false,
    backedBy: "default",
  },
];

// Extracted from apps/roam/src/data/defaultDiscourseRelations.ts
// Only the metadata we need — the full triple/condition trees are internal to the extension
export const DEFAULT_RELATIONS: DiscourseRelationType[] = [
  {
    id: "informs",
    label: "Informs",
    source: "_EVD-node",
    destination: "_QUE-node",
    complement: "Informed By",
  },
  {
    id: "supports",
    label: "Supports",
    source: "_EVD-node",
    destination: "_CLM-node",
    complement: "Supported By",
  },
  {
    id: "opposes",
    label: "Opposes",
    source: "_EVD-node",
    destination: "_CLM-node",
    complement: "Opposed By",
  },
];
