import type {
  DatalogClause,
  DatalogArgument,
  DatalogBinding,
  DatalogSrcVar,
} from "./types.js";
import type { InternalDiscourseNodeType } from "../types.js";
import conditionToDatalog from "./condition-to-datalog.js";
import getDiscourseNodeFormatExpression from "../format-expression.js";

export const replaceDatalogVariables = (
  replacements: (
    | { from: string; to: string }
    | { from: true; to: (value: string) => string }
  )[] = [],
  clauses: DatalogClause[],
): DatalogClause[] => {
  const replaceVariable = (
    argument: Extract<DatalogArgument, { type: "variable" }>,
  ): DatalogArgument => {
    const replacement = replacements.find(
      (candidate) =>
        candidate.from === true || candidate.from === argument.value,
    );
    if (!replacement) return { ...argument };
    if (replacement.from === true) {
      return { ...argument, value: replacement.to(argument.value) };
    }
    return { ...argument, value: replacement.to };
  };

  const replaceBinding = (binding: DatalogBinding): DatalogBinding => {
    if (binding.type === "bind-rel") return { ...binding };
    return {
      type: "bind-scalar",
      variable:
        binding.variable.type === "variable"
          ? replaceVariable(binding.variable)
          : { ...binding.variable },
    };
  };

  const replaceSrcVar = (srcVar?: DatalogSrcVar): DatalogSrcVar | undefined =>
    srcVar ? { ...srcVar } : undefined;

  return clauses.map((clause): DatalogClause => {
    switch (clause.type) {
      case "data-pattern":
      case "rule-expr":
        return {
          ...clause,
          srcVar: replaceSrcVar(clause.srcVar),
          arguments: clause.arguments.map((argument) =>
            argument.type === "variable"
              ? replaceVariable(argument)
              : { ...argument },
          ),
        };
      case "pred-expr":
        return {
          ...clause,
          arguments: clause.arguments.map((argument) =>
            argument.type === "variable"
              ? replaceVariable(argument)
              : { ...argument },
          ),
        };
      case "fn-expr":
        return {
          ...clause,
          arguments: clause.arguments.map((argument) =>
            argument.type === "variable"
              ? replaceVariable(argument)
              : { ...argument },
          ),
          binding: replaceBinding(clause.binding),
        };
      case "not-join-clause":
      case "or-join-clause":
        return {
          ...clause,
          srcVar: replaceSrcVar(clause.srcVar),
          variables: clause.variables.map((argument) =>
            argument.type === "variable"
              ? replaceVariable(argument)
              : { ...argument },
          ),
          clauses: replaceDatalogVariables(replacements, clause.clauses),
        };
      case "not-clause":
      case "or-clause":
        return {
          ...clause,
          srcVar: replaceSrcVar(clause.srcVar),
          clauses: replaceDatalogVariables(replacements, clause.clauses),
        };
      case "and-clause":
        return {
          ...clause,
          clauses: replaceDatalogVariables(replacements, clause.clauses),
        };
      default:
        return clause;
    }
  });
};

export const discourseNodeToDatalog = ({
  freeVar,
  node,
}: {
  freeVar: string;
  node: InternalDiscourseNodeType;
}): DatalogClause[] => {
  if (node.specification.length) {
    const clauses = node.specification.flatMap(conditionToDatalog);
    return replaceDatalogVariables([{ from: node.name, to: freeVar }], clauses);
  }

  const regex = getDiscourseNodeFormatExpression(node.format);
  return conditionToDatalog({
    source: freeVar,
    relation: "has title",
    target: `/${regex.source}/`,
    type: "clause",
    uid: `${node.typeId}-format-spec`,
    not: false,
  });
};

export const looksLikeUid = (value: string) =>
  /^[A-Za-z0-9_-]{9}$/.test(value.trim());
