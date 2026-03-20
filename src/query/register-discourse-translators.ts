// Register discourse-specific Datalog translators that depend on the live
// discourse config. The extension does this at plugin load; in the MCP we do it
// per request so the translators can use the current graph config.

import conditionToDatalog, {
  registerDatalogTranslator,
  getTitleDatalog,
} from "./condition-to-datalog.js";
import type { DatalogClause } from "./types.js";
import gatherDatalogVariablesFromClause from "./gather-variables.js";
import { toVar } from "./compile-datalog.js";
import {
  discourseNodeToDatalog,
  looksLikeUid,
  replaceDatalogVariables,
} from "./discourse-node-utils.js";
import type {
  InternalDiscourseNodeType,
  InternalDiscourseRelationType,
} from "../types.js";

const ANY_DISCOURSE_NODE = "Any discourse node";

const singleOrClause = (
  clauses: DatalogClause[],
  variables?: string[],
): DatalogClause | null => {
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0];
  if (variables?.length) {
    return {
      type: "or-join-clause",
      variables: variables.map((value) => ({
        type: "variable",
        value,
      })),
      clauses,
    };
  }
  return {
    type: "or-clause",
    clauses,
  };
};

const looksLikeTitleLiteral = (value: string) =>
  /[\s[\]()/#:]/.test(value.trim());

export function registerDiscourseTranslators({
  nodes,
  relations,
}: {
  nodes: InternalDiscourseNodeType[];
  relations: InternalDiscourseRelationType[];
}): () => void {
  const unregisters: Array<() => void> = [];

  const nodeByNameOrType = new Map<string, InternalDiscourseNodeType>();
  const nodeTypeByLabel = new Map<string, string>();
  const nodeNameByType = new Map<string, string>();

  for (const node of nodes) {
    nodeByNameOrType.set(node.name, node);
    nodeByNameOrType.set(node.typeId, node);
    nodeTypeByLabel.set(node.name.toLowerCase(), node.typeId);
    nodeNameByType.set(node.typeId, node.name);
  }

  const classifyValue = (value: string) => {
    const normalized = value.trim();
    if (nodeByNameOrType.has(normalized)) return "nodeType" as const;
    if (looksLikeUid(normalized)) return "uid" as const;
    if (looksLikeTitleLiteral(normalized)) return "title" as const;
    return "variable" as const;
  };

  const isACallback: Parameters<
    typeof registerDatalogTranslator
  >[0]["callback"] = ({ source, target }) => {
    if (target === ANY_DISCOURSE_NODE) {
      const discourseNodes = nodes.filter((node) => node.backedBy !== "default");
      const clauses = discourseNodes.map((node) => ({
        type: "and-clause" as const,
        clauses: discourseNodeToDatalog({ freeVar: source, node }),
      }));
      return clauses.length
        ? [
            {
              type: "or-join-clause",
              variables: [{ type: "variable", value: source }],
              clauses,
            },
          ]
        : [];
    }

    const node = nodeByNameOrType.get(target);
    if (!node) return [];
    return discourseNodeToDatalog({ freeVar: source, node });
  };

  const isACandidateCallback: Parameters<
    typeof registerDatalogTranslator
  >[0]["callback"] = ({ source, target }) => {
    const getCandidateClauses = (node: InternalDiscourseNodeType) => {
      if (!node.tag) return null;
      const tagClean = node.tag.startsWith("#") ? node.tag.slice(1) : node.tag;
      const variableRef = `${toVar(node.tag)}-ref`;
      return {
        type: "and-clause" as const,
        clauses: [
          {
            type: "data-pattern" as const,
            arguments: [
              { type: "variable" as const, value: source },
              { type: "constant" as const, value: ":block/refs" },
              { type: "variable" as const, value: variableRef },
            ],
          },
          ...getTitleDatalog({
            source: variableRef,
            target: tagClean,
          }),
        ],
      };
    };

    if (target === ANY_DISCOURSE_NODE) {
      const clauses = nodes
        .map(getCandidateClauses)
        .filter((clause): clause is NonNullable<typeof clause> => !!clause);
      return clauses.length
        ? [
            {
              type: "or-join-clause",
              variables: [{ type: "variable", value: source }],
              clauses,
            },
          ]
        : [];
    }

    const node = nodeByNameOrType.get(target);
    const clause = node ? getCandidateClauses(node) : null;
    return clause ? clause.clauses : [];
  };

  const computeEdgeTriple = ({
    variable,
    value,
    nodeType,
    uid,
  }: {
    variable: string;
    value: string;
    nodeType: string;
    uid: string;
  }): DatalogClause[] => {
    const valueType = classifyValue(value);
    switch (valueType) {
      case "nodeType":
        return conditionToDatalog({
          uid,
          not: false,
          source: variable,
          relation: "is a",
          target: value,
          type: "clause",
        });
      case "uid":
        return [
          {
            type: "data-pattern",
            arguments: [
              { type: "variable", value: variable },
              { type: "constant", value: ":block/uid" },
              { type: "constant", value: `"${value}"` },
            ],
          },
        ];
      case "title":
        return conditionToDatalog({
          uid,
          not: false,
          source: variable,
          relation: "has title",
          target: value,
          type: "clause",
        });
      case "variable":
        return conditionToDatalog({
          uid,
          not: false,
          source: variable,
          relation: "is a",
          target: nodeType,
          type: "clause",
        });
    }
  };

  unregisters.push(
    registerDatalogTranslator({
      key: "is a",
      callback: isACallback,
      targetOptions: nodes
        .map((node) => node.name)
        .concat(ANY_DISCOURSE_NODE),
      placeholder: "Enter a discourse node",
    }),
  );

  unregisters.push(
    registerDatalogTranslator({
      key: "is a candidate",
      callback: isACandidateCallback,
      targetOptions: nodes
        .filter((node) => !!node.tag)
        .map((node) => node.name)
        .concat(ANY_DISCOURSE_NODE),
      placeholder: "Enter a discourse node",
    }),
  );

  unregisters.push(
    registerDatalogTranslator({
      key: "self",
      callback: ({ source, uid }) =>
        isACallback({ source, target: source, uid }),
    }),
  );

  const relationLabels = new Set(
    relations.flatMap((relation) =>
      [relation.label, relation.complement].filter(Boolean),
    ),
  );

  relationLabels.forEach((label) => {
    unregisters.push(
      registerDatalogTranslator({
        key: label,
        callback: ({ source, target, uid }) => {
          const sourceDeclaredType = nodeTypeByLabel.get(source.toLowerCase());
          const targetDeclaredType = nodeTypeByLabel.get(target.toLowerCase());

          const matchingRelations = relations.flatMap((relation) => {
            const matches: Array<{
              relation: InternalDiscourseRelationType;
              forward: boolean;
              expectedSource: string;
              expectedTarget: string;
            }> = [];

            if (relation.label === label) {
              matches.push({
                relation,
                forward: true,
                expectedSource: relation.source,
                expectedTarget: relation.destination,
              });
            }
            if (relation.complement === label) {
              matches.push({
                relation,
                forward: false,
                expectedSource: relation.destination,
                expectedTarget: relation.source,
              });
            }

            return matches.filter(
              ({ expectedSource, expectedTarget }) =>
                (!sourceDeclaredType ||
                  expectedSource === "*" ||
                  expectedSource === sourceDeclaredType) &&
                (!targetDeclaredType ||
                  expectedTarget === "*" ||
                  expectedTarget === targetDeclaredType),
            );
          });

          const andParts = matchingRelations
            .map(({ relation, forward }) => {
              const sourceTriple = relation.triples.find(
                (triple) => triple[2] === "source",
              );
              const targetTriple = relation.triples.find(
                (triple) =>
                  triple[2] === "destination" || triple[2] === "target",
              );

              if (!sourceTriple || !targetTriple) return [];

              const edgeTriples = forward
                ? computeEdgeTriple({
                    value: source,
                    variable: sourceTriple[0],
                    nodeType: relation.source,
                    uid,
                  })
                    .concat(
                      computeEdgeTriple({
                        value: target,
                        variable: targetTriple[0],
                        nodeType: relation.destination,
                        uid,
                      }),
                    )
                    .concat([
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: sourceTriple[0] },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${source}-uid` },
                        ],
                      },
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: source },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${source}-uid` },
                        ],
                      },
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: targetTriple[0] },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${target}-uid` },
                        ],
                      },
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: target },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${target}-uid` },
                        ],
                      },
                    ])
                : computeEdgeTriple({
                    value: target,
                    variable: sourceTriple[0],
                    nodeType: relation.source,
                    uid,
                  })
                    .concat(
                      computeEdgeTriple({
                        value: source,
                        variable: targetTriple[0],
                        nodeType: relation.destination,
                        uid,
                      }),
                    )
                    .concat([
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: targetTriple[0] },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${source}-uid` },
                        ],
                      },
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: source },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${source}-uid` },
                        ],
                      },
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: sourceTriple[0] },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${target}-uid` },
                        ],
                      },
                      {
                        type: "data-pattern" as const,
                        arguments: [
                          { type: "variable" as const, value: target },
                          { type: "constant" as const, value: ":block/uid" },
                          { type: "variable" as const, value: `${target}-uid` },
                        ],
                      },
                    ]);

              const subQuery = relation.triples
                .filter(
                  (triple) => triple !== sourceTriple && triple !== targetTriple,
                )
                .flatMap(([tripleSource, tripleRelation, tripleTarget]) =>
                  conditionToDatalog({
                    source: tripleSource,
                    relation: tripleRelation,
                    target: tripleTarget,
                    not: false,
                    uid,
                    type: "clause",
                  }),
                );

              return replaceDatalogVariables(
                [
                  { from: source, to: source },
                  { from: target, to: target },
                  { from: true, to: (value) => `${uid}-${value}` },
                ],
                edgeTriples.concat(subQuery),
              );
            })
            .filter((clauses) => clauses.length > 0);

          if (!andParts.length) return [];
          if (andParts.length === 1) return andParts[0];

          const sharedVariables = new Set(
            Array.from(
              gatherDatalogVariablesFromClause({
                type: "and-clause",
                clauses: andParts[0],
              }),
            ),
          );

          andParts.slice(1).forEach((clauses) => {
            const freeVariables = gatherDatalogVariablesFromClause({
              type: "and-clause",
              clauses,
            });
            Array.from(sharedVariables).forEach((value) => {
              if (!freeVariables.has(value)) sharedVariables.delete(value);
            });
          });

          return [
            {
              type: "or-join-clause",
              variables: Array.from(sharedVariables).map((value) => ({
                type: "variable",
                value,
              })),
              clauses: andParts.map((clauses) => ({
                type: "and-clause",
                clauses,
              })),
            },
          ];
        },
        targetOptions: () => {
          const targetTypes = relations
            .filter((relation) => relation.label === label)
            .map((relation) => nodeNameByType.get(relation.destination) || relation.destination)
            .concat(
              relations
                .filter((relation) => relation.complement === label)
                .map((relation) => nodeNameByType.get(relation.source) || relation.source),
            );
          return [...new Set(targetTypes)].filter(Boolean);
        },
      }),
    );
  });

  return () => unregisters.forEach((fn) => fn());
}
