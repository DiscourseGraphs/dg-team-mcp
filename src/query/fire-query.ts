// MODIFIED from apps/roam/src/utils/fireQuery.ts
// — Uses tuple-only queries for Local API compatibility
// — Supports a read-only subset of query-builder selections
// — Surfaces unsupported selections instead of silently dropping them

import type { RoamClient } from "@roam-research/roam-tools-core";
import conditionToDatalog from "./condition-to-datalog.js";
import type {
  DatalogClause,
  DatalogAndClause,
  Condition,
  Selection,
  Result as QueryResult,
} from "./types.js";
import compileDatalog, { toVar } from "./compile-datalog.js";
import gatherDatalogVariablesFromClause from "./gather-variables.js";
import { DEFAULT_RETURN_NODE } from "./parse-query.js";
import { datalogQuery } from "../roam.js";

export type QueryArgs = {
  returnNode?: string;
  conditions: Condition[];
  selections: Selection[];
  inputs?: Record<string, string | number>;
};

export type FireQueryArgs = QueryArgs & {
  isCustomEnabled?: boolean;
  customNode?: string;
};

export type FireQueryDetailedResult = {
  results: QueryResult[];
  unsupportedSelections: string[];
};

type QueryProjection = {
  findVariables: string[];
  whereClauses: DatalogClause[];
  apply: (row: unknown[], startIndex: number, result: QueryResult) => number;
};

const CREATE_DATE_TEST = /^\s*created?\s*(date|time|since)\s*$/i;
const EDIT_DATE_TEST = /^\s*edit(?:ed)?\s*(date|time|since)\s*$/i;
const CREATE_BY_TEST = /^\s*(author|create(d)?\s*by)\s*$/i;
const EDIT_BY_TEST = /^\s*(last\s*)?edit(ed)?\s*by\s*$/i;
const NODE_TEST = /^node:(\s*[^:]+\s*)(:.*)?$/i;
const UID_TEST = /^\s*uid\s*$/i;

const formatRelativeTime = (timestamp: number): string => {
  const diffMs = Date.now() - timestamp;
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
};

const formatTimestampForSelection = (
  selectionText: string,
  timestamp: number,
): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (/since/i.test(selectionText)) return formatRelativeTime(timestamp);
  if (/time/i.test(selectionText)) {
    return `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
  }
  return date.toISOString();
};

const buildBaseProjection = (entityVar: string): QueryProjection => {
  const uidVar = `${entityVar}__uid`;
  const titleVar = `${entityVar}__title`;
  const stringVar = `${entityVar}__string`;

  return {
    findVariables: [uidVar, titleVar, stringVar],
    whereClauses: [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: entityVar },
          { type: "constant", value: ":block/uid" },
          { type: "variable", value: uidVar },
        ],
      },
      {
        type: "fn-expr",
        fn: "get-else",
        arguments: [
          { type: "constant", value: "$" },
          { type: "variable", value: entityVar },
          { type: "constant", value: ":node/title" },
          { type: "constant", value: '""' },
        ],
        binding: {
          type: "bind-scalar",
          variable: { type: "variable", value: titleVar },
        },
      },
      {
        type: "fn-expr",
        fn: "get-else",
        arguments: [
          { type: "constant", value: "$" },
          { type: "variable", value: entityVar },
          { type: "constant", value: ":block/string" },
          { type: "constant", value: '""' },
        ],
        binding: {
          type: "bind-scalar",
          variable: { type: "variable", value: stringVar },
        },
      },
    ],
    apply: (row, startIndex, result) => {
      const uid = String(row[startIndex] ?? "");
      const title = String(row[startIndex + 1] ?? "");
      const text = String(row[startIndex + 2] ?? "");
      result.uid = uid;
      result.text = title || text;
      return 3;
    },
  };
};

const buildNodeProjection = ({
  entityVar,
  label,
  prefix,
}: {
  entityVar: string;
  label: string;
  prefix: string;
}): QueryProjection => {
  const uidVar = `${prefix}__uid`;
  const titleVar = `${prefix}__title`;
  const stringVar = `${prefix}__string`;

  return {
    findVariables: [uidVar, titleVar, stringVar],
    whereClauses: [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: entityVar },
          { type: "constant", value: ":block/uid" },
          { type: "variable", value: uidVar },
        ],
      },
      {
        type: "fn-expr",
        fn: "get-else",
        arguments: [
          { type: "constant", value: "$" },
          { type: "variable", value: entityVar },
          { type: "constant", value: ":node/title" },
          { type: "constant", value: '""' },
        ],
        binding: {
          type: "bind-scalar",
          variable: { type: "variable", value: titleVar },
        },
      },
      {
        type: "fn-expr",
        fn: "get-else",
        arguments: [
          { type: "constant", value: "$" },
          { type: "variable", value: entityVar },
          { type: "constant", value: ":block/string" },
          { type: "constant", value: '""' },
        ],
        binding: {
          type: "bind-scalar",
          variable: { type: "variable", value: stringVar },
        },
      },
    ],
    apply: (row, startIndex, result) => {
      const uid = String(row[startIndex] ?? "");
      const title = String(row[startIndex + 1] ?? "");
      const text = String(row[startIndex + 2] ?? "");
      result[label] = title || text;
      result[`${label}-uid`] = uid;
      return 3;
    },
  };
};

const buildTimestampProjection = ({
  entityVar,
  label,
  prefix,
  selectionText,
  kind,
}: {
  entityVar: string;
  label: string;
  prefix: string;
  selectionText: string;
  kind: "create" | "edit";
}): QueryProjection => {
  const createVar = `${prefix}__create_time`;
  const valueVar = `${prefix}__${kind}_time`;

  return {
    findVariables: kind === "edit" ? [createVar, valueVar] : [valueVar],
    whereClauses:
      kind === "edit"
        ? [
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: entityVar },
                { type: "constant", value: ":create/time" },
                { type: "constant", value: "0" },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: createVar },
              },
            },
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: entityVar },
                { type: "constant", value: ":edit/time" },
                { type: "variable", value: createVar },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: valueVar },
              },
            },
          ]
        : [
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: entityVar },
                { type: "constant", value: ":create/time" },
                { type: "constant", value: "0" },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: valueVar },
              },
            },
          ],
    apply: (row, startIndex, result) => {
      const rawValue =
        kind === "edit" ? row[startIndex + 1] : row[startIndex];
      const timestamp = Number(rawValue ?? 0);
      result[label] = formatTimestampForSelection(selectionText, timestamp);
      result[`${label}-ts`] = timestamp;
      return kind === "edit" ? 2 : 1;
    },
  };
};

const buildUserProjection = ({
  entityVar,
  label,
  prefix,
  kind,
}: {
  entityVar: string;
  label: string;
  prefix: string;
  kind: "create" | "edit";
}): QueryProjection => {
  const createUserVar = `${prefix}__create_user`;
  const userVar = `${prefix}__${kind}_user`;
  const nameVar = `${prefix}__${kind}_user_name`;

  return {
    findVariables: [nameVar],
    whereClauses:
      kind === "edit"
        ? [
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: entityVar },
                { type: "constant", value: ":create/user" },
                { type: "constant", value: "0" },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: createUserVar },
              },
            },
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: entityVar },
                { type: "constant", value: ":edit/user" },
                { type: "variable", value: createUserVar },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: userVar },
              },
            },
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: userVar },
                { type: "constant", value: ":user/display-name" },
                { type: "constant", value: '"Anonymous User"' },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: nameVar },
              },
            },
          ]
        : [
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: entityVar },
                { type: "constant", value: ":create/user" },
                { type: "constant", value: "0" },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: userVar },
              },
            },
            {
              type: "fn-expr",
              fn: "get-else",
              arguments: [
                { type: "constant", value: "$" },
                { type: "variable", value: userVar },
                { type: "constant", value: ":user/display-name" },
                { type: "constant", value: '"Anonymous User"' },
              ],
              binding: {
                type: "bind-scalar",
                variable: { type: "variable", value: nameVar },
              },
            },
          ],
    apply: (row, startIndex, result) => {
      result[label] = String(row[startIndex] ?? "");
      return 1;
    },
  };
};

const buildSelectionProjections = ({
  selections,
  returnNode,
  whereClauses,
}: {
  selections: Selection[];
  returnNode: string;
  whereClauses: DatalogClause[];
}) => {
  const availableVariables = new Set(
    whereClauses.flatMap((clause) =>
      Array.from(gatherDatalogVariablesFromClause(clause)),
    ),
  );
  availableVariables.add(returnNode);

  const projections: QueryProjection[] = [];
  const unsupportedSelections: string[] = [];

  selections.forEach((selection) => {
    const selectionText = selection.text.trim();
    const label = selection.label || selection.text;
    const prefix = `${selection.uid || label}`;

    if (/^node$/i.test(selectionText)) return;

    if (UID_TEST.test(selectionText)) {
      projections.push({
        findVariables: [],
        whereClauses: [],
        apply: (_row, _startIndex, result) => {
          result[label] = result.uid;
          return 0;
        },
      });
      return;
    }

    if (CREATE_DATE_TEST.test(selectionText)) {
      projections.push(
        buildTimestampProjection({
          entityVar: returnNode,
          label,
          prefix,
          selectionText,
          kind: "create",
        }),
      );
      return;
    }

    if (EDIT_DATE_TEST.test(selectionText)) {
      projections.push(
        buildTimestampProjection({
          entityVar: returnNode,
          label,
          prefix,
          selectionText,
          kind: "edit",
        }),
      );
      return;
    }

    if (CREATE_BY_TEST.test(selectionText)) {
      projections.push(
        buildUserProjection({
          entityVar: returnNode,
          label,
          prefix,
          kind: "create",
        }),
      );
      return;
    }

    if (EDIT_BY_TEST.test(selectionText)) {
      projections.push(
        buildUserProjection({
          entityVar: returnNode,
          label,
          prefix,
          kind: "edit",
        }),
      );
      return;
    }

    const nodeMatch = NODE_TEST.exec(selectionText);
    if (nodeMatch) {
      const variable = nodeMatch[1].trim();
      const suffix = (nodeMatch[2] || "").replace(/^:/, "").trim();

      if (!availableVariables.has(variable)) {
        unsupportedSelections.push(selection.text);
        return;
      }

      if (!suffix) {
        projections.push(
          buildNodeProjection({
            entityVar: variable,
            label,
            prefix,
          }),
        );
        return;
      }

      if (CREATE_DATE_TEST.test(suffix)) {
        projections.push(
          buildTimestampProjection({
            entityVar: variable,
            label,
            prefix,
            selectionText: suffix,
            kind: "create",
          }),
        );
        return;
      }

      if (EDIT_DATE_TEST.test(suffix)) {
        projections.push(
          buildTimestampProjection({
            entityVar: variable,
            label,
            prefix,
            selectionText: suffix,
            kind: "edit",
          }),
        );
        return;
      }

      if (CREATE_BY_TEST.test(suffix)) {
        projections.push(
          buildUserProjection({
            entityVar: variable,
            label,
            prefix,
            kind: "create",
          }),
        );
        return;
      }

      if (EDIT_BY_TEST.test(suffix)) {
        projections.push(
          buildUserProjection({
            entityVar: variable,
            label,
            prefix,
            kind: "edit",
          }),
        );
        return;
      }
    }

    unsupportedSelections.push(selection.text);
  });

  return { projections, unsupportedSelections };
};

// COPY-START from fireQuery.ts:68-173 (query optimizer, unchanged)
const optimizeQuery = (
  clauses: DatalogClause[],
  capturedVariables: Set<string>,
): DatalogClause[] => {
  const marked = clauses.map(() => false);
  const orderedClauses: (DatalogClause | DatalogAndClause)[] = [];
  const variablesByIndex: Record<number, Set<string>> = {};
  for (let i = 0; i < clauses.length; i++) {
    let bestClauseIndex = clauses.length;
    let bestClauseScore = Number.MAX_VALUE;
    clauses.forEach((c, j) => {
      if (marked[j]) return;
      let score = bestClauseScore;
      if (c.type === "data-pattern") {
        if (
          c.arguments[0]?.type === "variable" &&
          c.arguments[1]?.type === "constant"
        ) {
          if (c.arguments[2]?.type === "constant") {
            score = 1;
          } else if (
            c.arguments[2]?.type === "variable" &&
            (capturedVariables.has(c.arguments[0].value) ||
              capturedVariables.has(c.arguments[2].value))
          ) {
            score = 2;
          } else {
            score = 100000;
          }
        } else {
          score = 100001;
        }
      } else if (
        c.type === "not-clause" ||
        c.type === "or-clause" ||
        c.type === "and-clause"
      ) {
        const allVars =
          variablesByIndex[j] ||
          (variablesByIndex[j] = gatherDatalogVariablesFromClause(c));
        if (Array.from(allVars).every((v) => capturedVariables.has(v))) {
          score = 10;
        } else {
          score = 100002;
        }
      } else if (c.type === "not-join-clause" || c.type === "or-join-clause") {
        if (c.variables.every((v) => capturedVariables.has(v.value))) {
          score = 100;
        } else {
          score = 100003;
        }
      } else if (
        c.type === "fn-expr" ||
        c.type === "pred-expr" ||
        c.type === "rule-expr"
      ) {
        if (
          [...c.arguments].every(
            (a) => a.type !== "variable" || capturedVariables.has(a.value),
          )
        ) {
          c.type == "pred-expr" && c.pred == "=" ? (score = 5) : (score = 1000);
        } else {
          score = 100004;
        }
      } else {
        score = 100005;
      }
      if (score < bestClauseScore) {
        bestClauseScore = score;
        bestClauseIndex = j;
      }
    });
    marked[bestClauseIndex] = true;
    const bestClause = clauses[bestClauseIndex];
    orderedClauses.push(clauses[bestClauseIndex]);
    if (
      bestClause.type === "not-join-clause" ||
      bestClause.type === "or-join-clause" ||
      bestClause.type === "not-clause" ||
      bestClause.type === "or-clause" ||
      bestClause.type === "and-clause"
    ) {
      bestClause.clauses = optimizeQuery(
        bestClause.clauses,
        new Set(capturedVariables),
      );
    } else if (bestClause.type === "data-pattern") {
      bestClause.arguments
        .filter((v) => v.type === "variable")
        .forEach((v) => capturedVariables.add(v.value));
    } else if (bestClause.type === "fn-expr") {
      if (
        bestClause.arguments.filter(
          (a) => a.type === "variable" && !capturedVariables.has(a.value),
        ).length === 0 &&
        bestClause.binding.type === "bind-scalar" &&
        bestClause.binding.variable.type === "variable"
      )
        capturedVariables.add(bestClause.binding.variable.value);
    }
  }
  return orderedClauses;
};
// COPY-END

export const getWhereClauses = ({
  conditions,
  returnNode = DEFAULT_RETURN_NODE,
}: Omit<QueryArgs, "selections">) => {
  return conditions.length
    ? conditions.flatMap(conditionToDatalog)
    : conditionToDatalog({
        relation: "self",
        source: returnNode,
        target: returnNode,
        uid: "",
        not: false,
        type: "clause",
      });
};

const getConditionTargets = (conditions: Condition[]): string[] =>
  conditions.flatMap((condition) =>
    condition.type === "clause" || condition.type === "not"
      ? [condition.target]
      : getConditionTargets(condition.conditions.flat()),
  );

export const getDatalogQuery = ({
  conditions,
  selections,
  returnNode = DEFAULT_RETURN_NODE,
  inputs = {},
}: FireQueryArgs) => {
  const expectedInputs = getConditionTargets(conditions)
    .filter((target) => /^:in /.test(target))
    .map((target) => target.substring(4))
    .filter((target) => typeof inputs[target] !== "undefined")
    .filter((value, index, array) => array.indexOf(value) === index);

  const initialWhereClauses = getWhereClauses({ conditions, returnNode });
  const { projections, unsupportedSelections } = buildSelectionProjections({
    selections,
    returnNode,
    whereClauses: initialWhereClauses,
  });

  const allProjections = [buildBaseProjection(returnNode), ...projections];
  const whereClauses = optimizeQuery(
    initialWhereClauses.concat(
      allProjections.flatMap((projection) => projection.whereClauses),
    ),
    new Set([]),
  );

  const findVariables = allProjections.flatMap(
    (projection) => projection.findVariables,
  );
  const where = whereClauses.map((clause) => compileDatalog(clause, 1)).join("\n");

  return {
    query: `[:find\n  ${findVariables.map((value) => `?${toVar(value)}`).join("\n  ")}\n${
      expectedInputs.length
        ? `  :in $ ${expectedInputs.map((value) => `?${toVar(value)}`).join(" ")}\n`
        : ""
    }:where\n${
      whereClauses.length === 1 && whereClauses[0].type === "not-clause"
        ? `[?node :block/uid _]`
        : ""
    }${where}\n]`,
    inputs: expectedInputs.map((value) => inputs[value]),
    unsupportedSelections,
    formatResult: (row: unknown[]): QueryResult => {
      const result = { text: "", uid: "" } as QueryResult;
      let offset = 0;
      allProjections.forEach((projection) => {
        offset += projection.apply(row, offset, result);
      });
      return result;
    },
  };
};

export const fireQueryDetailed = async (
  client: RoamClient,
  args: FireQueryArgs,
): Promise<FireQueryDetailedResult> => {
  const { isCustomEnabled, customNode, ...rest } = args;

  if (isCustomEnabled) {
    try {
      const rows = await datalogQuery<unknown[]>(client, customNode as string);
      return {
        unsupportedSelections: [],
        results: rows.map((row) => {
          const cells = Array.isArray(row) ? row : [row];
          return {
            text: "",
            uid: "",
            ...Object.fromEntries(
              cells.map((value, index) => [index.toString(), value as string | number]),
            ),
          };
        }),
      };
    } catch (error) {
      console.error("Query error:", (error as Error).message);
      return { results: [], unsupportedSelections: [] };
    }
  }

  const { query, inputs, unsupportedSelections, formatResult } =
    getDatalogQuery(rest);

  try {
    const rows = await datalogQuery<unknown[]>(client, query, ...inputs);
    return {
      unsupportedSelections,
      results: rows
        .filter((row) => Array.isArray(row))
        .map((row) => formatResult(row)),
    };
  } catch (error) {
    console.error("Query error:", (error as Error).message);
    return { results: [], unsupportedSelections };
  }
};

const fireQuery = async (
  client: RoamClient,
  args: FireQueryArgs,
): Promise<QueryResult[]> => {
  const detailed = await fireQueryDetailed(client, args);
  return detailed.results;
};

export default fireQuery;
