// COPY from roamjs-components/types/native (Datalog AST types)
// Cannot import directly — roamjs-components has browser deps at module level.

// --- Datalog AST ---

export type DatalogArgument =
  | { type: "constant"; value: string }
  | { type: "variable"; value: string }
  | { type: "underscore"; value: string };

export type DatalogSrcVar = { type: "src-var"; value: string };

export type DatalogBinding =
  | { type: "bind-scalar"; variable: DatalogArgument }
  | { type: "bind-rel"; args: DatalogArgument[] };

export type DatalogClause =
  | DatalogDataPattern
  | DatalogFnExpr
  | DatalogPredExpr
  | DatalogRuleExpr
  | DatalogNotClause
  | DatalogOrClause
  | DatalogAndClause
  | DatalogNotJoinClause
  | DatalogOrJoinClause;

export type DatalogDataPattern = {
  type: "data-pattern";
  arguments: DatalogArgument[];
  srcVar?: DatalogSrcVar;
};

export type DatalogFnExpr = {
  type: "fn-expr";
  fn: string;
  arguments: DatalogArgument[];
  binding: DatalogBinding;
};

export type DatalogPredExpr = {
  type: "pred-expr";
  pred: string;
  arguments: DatalogArgument[];
};

export type DatalogRuleExpr = {
  type: "rule-expr";
  arguments: DatalogArgument[];
  srcVar?: DatalogSrcVar;
};

export type DatalogNotClause = {
  type: "not-clause";
  clauses: DatalogClause[];
  srcVar?: DatalogSrcVar;
};

export type DatalogOrClause = {
  type: "or-clause";
  clauses: DatalogClause[];
  srcVar?: DatalogSrcVar;
};

export type DatalogAndClause = {
  type: "and-clause";
  clauses: DatalogClause[];
};

export type DatalogNotJoinClause = {
  type: "not-join-clause";
  clauses: DatalogClause[];
  variables: DatalogArgument[];
  srcVar?: DatalogSrcVar;
};

export type DatalogOrJoinClause = {
  type: "or-join-clause";
  clauses: DatalogClause[];
  variables: DatalogArgument[];
  srcVar?: DatalogSrcVar;
};

// --- PullBlock (Roam query result) ---

export type PullBlock = {
  ":block/uid"?: string;
  ":block/string"?: string;
  ":node/title"?: string;
  ":block/children"?: PullBlock[];
  ":block/order"?: number;
  ":create/time"?: number;
  ":edit/time"?: number;
  ":create/user"?: { ":db/id"?: number };
  ":edit/user"?: { ":db/id"?: number };
  ":block/refs"?: PullBlock[];
  ":block/page"?: PullBlock;
  ":block/parents"?: PullBlock[];
  ":log/id"?: number;
  ":block/heading"?: number;
  ":block/props"?: Record<string, unknown>;
  ":db/id"?: number;
  [key: string]: unknown;
};

// --- Query Builder types (from apps/roam/src/utils/types.ts) ---
// COPY from apps/roam/src/utils/types.ts

type QBBase = { uid: string };

export type QBClauseData = {
  relation: string;
  source: string;
  target: string;
  not?: boolean;
} & QBBase;

export type QBNestedData = {
  conditions: Condition[][];
} & QBBase;

export type QBClause = QBClauseData & { type: "clause" };
export type QBNot = QBClauseData & { type: "not" };
export type QBOr = QBNestedData & { type: "or" };
export type QBNor = QBNestedData & { type: "not or" };

export type Condition = QBClause | QBNot | QBOr | QBNor;

export type Selection = {
  text: string;
  label: string;
  uid: string;
};

export type Result = {
  text: string;
  uid: string;
} & Record<string, string | number | Date>;

export type Column = { key: string; uid: string; selection: string };
