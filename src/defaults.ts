// COPY from apps/roam/src/utils/getDiscourseNodes.ts:37-74 (default nodes)
// COPY from apps/roam/src/components/settings/data/defaultRelationsBlockProps.ts
// MODIFIED: represented as the richer internal config shape so query matching
// can use the same semantics as the extension.

import type {
  InternalDiscourseNodeType,
  InternalDiscourseRelationType,
} from "./types.js";

export const DEFAULT_NODES: InternalDiscourseNodeType[] = [
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
    specification: [
      {
        type: "clause",
        source: "Page",
        relation: "has title",
        target: "/^(.*)$/",
        uid: "default-page-spec",
      },
    ],
    template: [],
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
    specification: [
      {
        type: "clause",
        source: "Block",
        relation: "is in page",
        target: "_",
        uid: "default-block-spec",
      },
    ],
    template: [],
  },
];

// Extracted from apps/roam/src/components/settings/data/defaultRelationsBlockProps.ts
export const DEFAULT_RELATIONS: InternalDiscourseRelationType[] = [
  {
    id: "informs",
    label: "Informs",
    source: "_EVD-node",
    destination: "_QUE-node",
    complement: "Informed By",
    triples: [
      ["Page", "is a", "source"],
      ["Block", "references", "Page"],
      ["Block", "is in page", "ParentPage"],
      ["ParentPage", "is a", "destination"],
    ],
  },
  {
    id: "supports",
    label: "Supports",
    source: "_EVD-node",
    destination: "_CLM-node",
    complement: "Supported By",
    triples: [
      ["Page", "is a", "source"],
      ["Block", "references", "Page"],
      ["SBlock", "references", "SPage"],
      ["SPage", "has title", "SupportedBy"],
      ["SBlock", "has child", "Block"],
      ["PBlock", "references", "ParentPage"],
      ["PBlock", "has child", "SBlock"],
      ["ParentPage", "is a", "destination"],
    ],
  },
  {
    id: "supports",
    label: "Supports",
    source: "_EVD-node",
    destination: "_CLM-node",
    complement: "Supported By",
    triples: [
      ["Page", "is a", "destination"],
      ["Block", "references", "Page"],
      ["SBlock", "references", "SPage"],
      ["SPage", "has title", "Supports"],
      ["SBlock", "has child", "Block"],
      ["PBlock", "references", "ParentPage"],
      ["PBlock", "has child", "SBlock"],
      ["ParentPage", "is a", "source"],
    ],
  },
  {
    id: "opposes",
    label: "Opposes",
    source: "_EVD-node",
    destination: "_CLM-node",
    complement: "Opposed By",
    triples: [
      ["Page", "is a", "source"],
      ["Block", "references", "Page"],
      ["SBlock", "references", "SPage"],
      ["SPage", "has title", "OpposedBy"],
      ["SBlock", "has child", "Block"],
      ["PBlock", "references", "ParentPage"],
      ["PBlock", "has child", "SBlock"],
      ["ParentPage", "is a", "destination"],
    ],
  },
  {
    id: "opposes",
    label: "Opposes",
    source: "_EVD-node",
    destination: "_CLM-node",
    complement: "Opposed By",
    triples: [
      ["Page", "is a", "destination"],
      ["Block", "references", "Page"],
      ["SBlock", "references", "SPage"],
      ["SPage", "has title", "Opposes"],
      ["SBlock", "has child", "Block"],
      ["PBlock", "references", "ParentPage"],
      ["PBlock", "has child", "SBlock"],
      ["ParentPage", "is a", "source"],
    ],
  },
];
