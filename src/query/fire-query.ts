// MODIFIED from apps/roam/src/utils/fireQuery.ts
// — Replaced window.roamAlphaAPI.data.backend.q() with datalogQuery()
// — Removed predefinedSelections (complex browser deps for result formatting)
// — Simplified to return basic text/uid results
// — Removed development logging, nanoid dependency
// — Removed local/async query distinction (MCP always uses backend.q)

import type { RoamClient } from "@roam-research/roam-tools-core";
import conditionToDatalog from "./condition-to-datalog.js";
import type {
  DatalogClause,
  DatalogAndClause,
  Condition,
  Selection,
  PullBlock,
  Result as QueryResult,
} from "./types.js";
import compileDatalog from "./compile-datalog.js";
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

// COPY-START from fireQuery.ts:43-66
const firstVariable = (
  clause: DatalogClause | DatalogAndClause,
): string | undefined => {
  if (
    clause.type === "data-pattern" ||
    clause.type === "fn-expr" ||
    clause.type === "pred-expr" ||
    clause.type === "rule-expr"
  ) {
    return [...clause.arguments].find((v) => v.type === "variable")?.value;
  } else if (
    clause.type === "not-clause" ||
    clause.type === "or-clause" ||
    clause.type === "and-clause"
  ) {
    return firstVariable(clause.clauses[0]);
  } else if (
    clause.type === "not-join-clause" ||
    clause.type === "or-join-clause"
  ) {
    return clause.variables[0]?.value;
  }
  return undefined;
};

// COPY-END

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

// COPY-START from fireQuery.ts:175-189
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
  conditions.flatMap((c) =>
    c.type === "clause" || c.type === "not"
      ? [c.target]
      : getConditionTargets(c.conditions.flat()),
  );

// COPY-END

// MODIFIED-START from fireQuery.ts:198-308
// — Simplified selections: only pull text/title/uid for return node
// — Removed predefinedSelections (too many browser deps)
export const getDatalogQuery = ({
  conditions,
  selections,
  returnNode = DEFAULT_RETURN_NODE,
  inputs = {},
}: FireQueryArgs) => {
  const expectedInputs = getConditionTargets(conditions)
    .filter((c) => /^:in /.test(c))
    .map((c) => c.substring(4))
    .filter((c) => !!inputs[c])
    .filter((value, index, array) => array.indexOf(value) === index);

  const whereClauses = optimizeQuery(
    getWhereClauses({ conditions, returnNode }),
    new Set([]),
  );

  // Simplified selections: pull text + uid for the return node
  const find = `(pull ?${returnNode} [:block/string :node/title :block/uid])`;
  const where = whereClauses.map((c) => compileDatalog(c, 1)).join("\n");

  return {
    query: `[:find\n  ${find}\n${
      expectedInputs.length
        ? `  :in $ ${expectedInputs.map((i) => `?${i}`).join(" ")}\n`
        : ""
    }:where\n${
      whereClauses.length === 1 && whereClauses[0].type === "not-clause"
        ? `[?node :block/uid _]`
        : ""
    }${where}\n]`,
    inputs: expectedInputs.map((i) => inputs[i]),
  };
};

// MODIFIED-END

// MODIFIED-START from fireQuery.ts:318-375
// — Uses datalogQuery() instead of window.roamAlphaAPI
// — Returns simplified QueryResult (text + uid)
const fireQuery = async (
  client: RoamClient,
  args: FireQueryArgs,
): Promise<QueryResult[]> => {
  const { isCustomEnabled, customNode, ...rest } = args;

  const { query, inputs } = isCustomEnabled
    ? { query: customNode as string, inputs: [] as unknown[] }
    : getDatalogQuery(rest);

  try {
    const queryResults = await datalogQuery<[PullBlock]>(
      client,
      query,
      ...inputs,
    );

    return queryResults
      .filter((r) => r != null && r[0] != null)
      .map((r) => {
        const pull = r[0] || {};
        return {
          text: (pull[":node/title"] as string) || (pull[":block/string"] as string) || "",
          uid: (pull[":block/uid"] as string) || "",
        };
      });
  } catch (e) {
    console.error("Query error:", (e as Error).message);
    return [];
  }
};
// MODIFIED-END

export default fireQuery;
