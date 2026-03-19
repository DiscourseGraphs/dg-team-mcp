// Output types — what the LLM sees when calling tools

export interface DiscourseNodeType {
  name: string;
  typeId: string;
  format: string;
  shortcut: string;
  tag: string;
  description: string;
  canvasSettings: Record<string, string>;
  graphOverview: boolean;
  backedBy: "user" | "default" | "relation";
}

export interface DiscourseRelationType {
  id: string;
  label: string;
  source: string;
  destination: string;
  complement: string;
}

export interface GetDiscourseNodeTypesResult {
  configured: boolean;
  nodes: DiscourseNodeType[];
  relations: DiscourseRelationType[];
}

// Internal types — Roam block tree representation

export interface TreeNode {
  uid: string;
  text: string;
  children: TreeNode[];
}

// Roam pull result shape (before normalization to TreeNode)
export interface RoamPullBlock {
  ":block/uid"?: string;
  ":block/string"?: string;
  ":block/order"?: number;
  ":block/children"?: RoamPullBlock[];
  ":node/title"?: string;
}
