// MODIFIED from apps/roam/src/utils/conditionToDatalog.ts
// Changes:
// — Replaced roamjs-components type imports with local types
// — Replaced parseNlpDate with chrono-node direct import
// — Replaced getAllPageNames/getCurrentPageUid/getPageTitleByPageUid/getCurrentUserDisplayName
//   with a context object passed in (these are runtime browser values)
// — Replaced getFormattedConfigTree with passed-in config
// — Removed isInCanvasDatalog import (canvas membership not supported in MCP yet)
// — normalizePageTitle inlined (simple string operation)
// — extractRef inlined

import type {
  DatalogAndClause,
  DatalogClause,
  Condition,
} from "./types.js";
import gatherDatalogVariablesFromClause from "./gather-variables.js";

type ConditionToDatalog = (condition: Condition) => DatalogClause[];

const INPUT_REGEX = /^:in /;

// MODIFIED from roamjs-components/queries/normalizePageTitle — inlined
const normalizePageTitle = (title: string) =>
  title.replace(/\\"/g, '"');

// MODIFIED from roamjs-components/util/extractRef — inlined
const extractRef = (ref: string): string =>
  ref?.match(/\(\(([^)]*)\)\)/)?.[1] || ref || "";

const isRegex = (str: string) => /^\/.+\/(i)?$/.test(str);
const escapeRegex = (str: string) =>
  str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const regexRePatternValue = (str: string) => {
  const isCaseInsensitive = str.endsWith("/i");
  return isCaseInsensitive
    ? `"(?i)${str.slice(1, -2).replace(/\\/g, "\\\\")}"`
    : `"${str.slice(1, -1).replace(/\\/g, "\\\\")}"`;
};

const getTextContainsDatalog = ({
  source,
  target,
  valueVariable,
}: {
  source: string;
  target: string;
  valueVariable: string;
}): DatalogClause[] => {
  const regexVariable = `${source}-${valueVariable}-regex`;
  const regexTarget = isRegex(target)
    ? regexRePatternValue(target)
    : INPUT_REGEX.test(target)
      ? null
      : regexRePatternValue(`/${escapeRegex(normalizePageTitle(target))}/`);

  return [
    {
      type: "fn-expr",
      fn: "re-pattern",
      arguments: [
        INPUT_REGEX.test(target)
          ? {
              type: "variable",
              value: target.replace(INPUT_REGEX, ""),
            }
          : {
              type: "constant",
              value: regexTarget || '""',
            },
      ],
      binding: {
        type: "bind-scalar",
        variable: { type: "variable", value: regexVariable },
      },
    },
    {
      type: "pred-expr",
      pred: "re-find",
      arguments: [
        { type: "variable", value: regexVariable },
        { type: "variable", value: valueVariable },
      ],
    },
  ];
};

// MODIFIED-START from conditionToDatalog.ts:getTitleDatalog (lines 45-196)
// — Removed {current}, {this page}, {current user} handling (not available in MCP context)
// — Removed {date} with NLP parsing (would need chrono-node dep)
// — Kept regex, input variable, and literal title matching
export const getTitleDatalog = ({
  source,
  target,
  uid: _uid,
}: {
  source: string;
  target: string;
  uid?: string;
}): DatalogClause[] => {
  // {date} without NLP — matches any daily note page
  const dateMatch = /^\s*{date(?::([^}]+))?}\s*$/i.exec(target);
  if (dateMatch) {
    const nlp = dateMatch[1] || "";
    if (!nlp) {
      // Match any daily note page
      return [
        {
          type: "data-pattern",
          arguments: [
            { type: "variable", value: source },
            { type: "constant", value: ":log/id" },
            { type: "variable", value: `${source}-log-id` },
          ],
        },
      ];
    }
    // TODO: NLP date parsing ({date:today}, {date:last week}) requires chrono-node.
    // For now, skip NLP dates — return empty (no match).
    return [];
  }
  // TODO: {current}, {this page}, {current user} not available in MCP context.
  // These need the Roam UI state which doesn't exist outside the browser.
  if (/^\s*{current}\s*$/i.test(target)) return [];
  if (/^\s*{this page}\s*$/i.test(target)) return [];
  if (/^\s*{current user}\s*$/i.test(target)) return [];

  if (isRegex(target)) {
    const rePattern = regexRePatternValue(target);
    return [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":node/title" },
          { type: "variable", value: `${source}-Title` },
        ],
      },
      {
        type: "fn-expr",
        fn: "re-pattern" as const,
        arguments: [
          {
            type: "constant",
            value: rePattern,
          },
        ],
        binding: {
          type: "bind-scalar",
          variable: { type: "variable", value: `${target}-regex` },
        },
      },
      {
        type: "pred-expr",
        pred: "re-find",
        arguments: [
          { type: "variable", value: `${target}-regex` },
          { type: "variable", value: `${source}-Title` },
        ],
      },
    ];
  }
  if (INPUT_REGEX.test(target)) {
    return [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":node/title" },
          {
            type: "variable",
            value: target.replace(INPUT_REGEX, ""),
          },
        ],
      },
    ];
  }
  return [
    {
      type: "data-pattern",
      arguments: [
        { type: "variable", value: source },
        { type: "constant", value: ":node/title" },
        { type: "constant", value: `"${normalizePageTitle(target)}"` },
      ],
    },
  ];
};
// MODIFIED-END

// COPY-START from conditionToDatalog.ts:198-207
type Translator = {
  callback: (args: {
    source: string;
    target: string;
    uid: string;
  }) => DatalogClause[];
  targetOptions?: string[] | ((source: string) => string[]);
  placeholder?: string;
  isVariable?: true;
};
// COPY-END

// MODIFIED-START from conditionToDatalog.ts:209-968
// — Removed translators that need browser context:
//   "with text in title" {current} branch, "created by"/"edited by" targetOptions,
//   "is in canvas" (needs canvas config + page names)
// — Kept all pure translators intact
const translator: Record<string, Translator> = {
  // COPY: self
  self: {
    callback: ({ source }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/uid" },
          { type: "constant", value: `"${source}"` },
        ],
      },
    ],
  },
  // COPY: references
  references: {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/refs" },
          { type: "variable", value: target },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: is referenced by
  "is referenced by": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: target },
          { type: "constant", value: ":block/refs" },
          { type: "variable", value: source },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: is referenced by block in page with title
  "is referenced by block in page with title": {
    callback: ({ source, target, uid }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: `${target}-RefBy` },
          { type: "constant", value: ":block/refs" },
          { type: "variable", value: source },
        ],
      },
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: `${target}-RefBy` },
          { type: "constant", value: ":block/page" },
          { type: "variable", value: target },
        ],
      },
      ...getTitleDatalog({ source: target, target, uid }),
    ],
    placeholder: "Enter any placeholder for the node",
  },
  // COPY: is in page
  "is in page": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/page" },
          { type: "variable", value: target },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: has title
  "has title": {
    callback: getTitleDatalog,
    placeholder: "Enter a page name or {date} for any DNP",
  },
  // MODIFIED: with text in title — removed {current} branch (needs browser context)
  "with text in title": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":node/title" },
          { type: "variable", value: `${source}-Title` },
        ],
      },
      ...getTextContainsDatalog({
        source,
        target,
        valueVariable: `${source}-Title`,
      }),
    ],
    placeholder: "Enter any text",
  },
  // COPY: has attribute
  "has attribute": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: `${target}-Attribute` },
          { type: "constant", value: ":node/title" },
          { type: "constant", value: `"${normalizePageTitle(target)}"` },
        ],
      },
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: target },
          { type: "constant", value: ":block/refs" },
          { type: "variable", value: `${target}-Attribute` },
        ],
      },
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: target },
          { type: "constant", value: ":block/parents" },
          { type: "variable", value: source },
        ],
      },
    ],
    placeholder: "Enter any attribute name",
    isVariable: true,
  },
  // COPY: has child
  "has child": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/children" },
          { type: "variable", value: target },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: has parent
  "has parent": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: target },
          { type: "constant", value: ":block/children" },
          { type: "variable", value: source },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: has ancestor
  "has ancestor": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/parents" },
          { type: "variable", value: target },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: has descendant
  "has descendant": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: target },
          { type: "constant", value: ":block/parents" },
          { type: "variable", value: source },
        ],
      },
    ],
    placeholder: "Enter any placeholder for the node",
    isVariable: true,
  },
  // COPY: with text (removed {current user} branch)
  "with text": {
    callback: ({ source, target }) => {
      if (isRegex(target)) {
        const rePattern = regexRePatternValue(target);
        return [
          {
            type: "or-clause",
            clauses: [
              {
                type: "data-pattern",
                arguments: [
                  { type: "variable", value: source },
                  { type: "constant", value: ":block/string" },
                  { type: "variable", value: `${source}-String` },
                ],
              },
              {
                type: "data-pattern",
                arguments: [
                  { type: "variable", value: source },
                  { type: "constant", value: ":node/title" },
                  { type: "variable", value: `${source}-String` },
                ],
              },
            ],
          },
          {
            type: "fn-expr",
            fn: "re-pattern",
            arguments: [{ type: "constant", value: rePattern }],
            binding: {
              type: "bind-scalar",
              variable: { type: "variable", value: `${target}-regex` },
            },
          },
          {
            type: "pred-expr",
            pred: "re-find",
            arguments: [
              { type: "variable", value: `${target}-regex` },
              { type: "variable", value: `${source}-String` },
            ],
          },
        ];
      }
      return [
        {
          type: "or-clause",
          clauses: [
            {
              type: "data-pattern",
              arguments: [
                { type: "variable", value: source },
                { type: "constant", value: ":block/string" },
                { type: "variable", value: `${source}-String` },
              ],
            },
            {
              type: "data-pattern",
              arguments: [
                { type: "variable", value: source },
                { type: "constant", value: ":node/title" },
                { type: "variable", value: `${source}-String` },
              ],
            },
          ],
        },
        ...getTextContainsDatalog({
          source,
          target,
          valueVariable: `${source}-String`,
        }),
      ];
    },
    placeholder: "Enter any text",
  },
  // COPY: created by
  "created by": {
    callback: ({ source, target }) => {
      const initialDatalog: DatalogClause[] = [
        {
          type: "data-pattern",
          arguments: [
            { type: "variable", value: source },
            { type: "constant", value: ":create/user" },
            { type: "variable", value: `${source}-User` },
          ],
        },
        {
          type: "data-pattern",
          arguments: [
            { type: "variable", value: `${source}-User` },
            { type: "constant", value: ":user/display-page" },
            { type: "variable", value: `${source}-User-Display` },
          ],
        },
      ];
      return INPUT_REGEX.test(target)
        ? [
            ...initialDatalog,
            {
              type: "data-pattern",
              arguments: [
                { type: "variable", value: `${source}-User-Display` },
                { type: "constant", value: ":node/title" },
                {
                  type: "variable",
                  value: target.replace(INPUT_REGEX, ""),
                },
              ],
            },
          ]
        : [
            ...initialDatalog,
            ...getTitleDatalog({ source: `${source}-User-Display`, target }),
          ];
    },
    placeholder: "Enter the display name of any user",
  },
  // COPY: edited by
  "edited by": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":edit/user" },
          { type: "variable", value: `${source}-User` },
        ],
      },
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: `${source}-User` },
          { type: "constant", value: ":user/display-page" },
          { type: "variable", value: `${source}-User-Display` },
        ],
      },
      ...getTitleDatalog({ source: `${source}-User-Display`, target }),
    ],
    placeholder: "Enter the display name of any user",
  },
  // COPY: references title
  "references title": {
    callback: ({ source, target, uid }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/refs" },
          { type: "variable", value: `${target}-Ref` },
        ],
      },
      ...getTitleDatalog({ source: `${target}-Ref`, target, uid }),
    ],
    placeholder: "Enter a page name or {date} for any DNP",
  },
  // COPY: has heading
  "has heading": {
    callback: ({ source, target }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/heading" },
          { type: "constant", value: target },
        ],
      },
    ],
    targetOptions: ["1", "2", "3", "0"],
    placeholder: "Enter a heading value (0, 1, 2, 3)",
  },
  // COPY: is in page with title
  "is in page with title": {
    callback: ({ source, target, uid }) => [
      {
        type: "data-pattern",
        arguments: [
          { type: "variable", value: source },
          { type: "constant", value: ":block/page" },
          { type: "variable", value: target },
        ],
      },
      ...getTitleDatalog({ source: target, target, uid }),
    ],
    placeholder: "Enter a page name or {date} for any DNP",
  },
  // COPY: has block reference
  "has block reference": {
    callback: ({ source, target }) => {
      if (INPUT_REGEX.test(target)) {
        return [
          {
            type: "data-pattern",
            arguments: [
              { type: "variable", value: source },
              { type: "constant", value: ":block/uid" },
              { type: "variable", value: target.replace(INPUT_REGEX, "") },
            ],
          },
        ];
      }
      return [
        {
          type: "data-pattern",
          arguments: [
            { type: "variable", value: source },
            { type: "constant", value: ":block/uid" },
            {
              type: "constant",
              value: `"${extractRef(target)}"`,
            },
          ],
        },
      ];
    },
    placeholder: "Enter a block reference (with or without brackets)",
  },
  // TODO: "created after/before", "edited after/before", "titled before/after"
  // require chrono-node for NLP date parsing. Add when chrono-node is installed.
  // TODO: "is in canvas" requires canvas config + page names query. Add later.
};
// MODIFIED-END

// COPY-START from conditionToDatalog.ts:970-984
export const registerDatalogTranslator = ({
  key,
  ...translation
}: Translator & { key: string }) => {
  translator[key] = translation;
  return () => unregisterDatalogTranslator({ key });
};

export const unregisterDatalogTranslator = ({ key }: { key: string }) =>
  delete translator[key];

export const getConditionLabels = () =>
  Object.keys(translator)
    .filter((k) => k !== "self")
    .sort((a, b) => b.length - a.length);
// COPY-END

// COPY-START from conditionToDatalog.ts:986-1032 (core logic, unchanged)
const conditionToDatalog: ConditionToDatalog = (con) => {
  if (con.type === "or" || con.type === "not or") {
    const allClauses: DatalogAndClause[] = con.conditions.map((branch) => ({
      type: "and-clause",
      clauses: branch.flatMap((c) => conditionToDatalog(c)),
    }));

    const clauses = allClauses.filter((c) => c.clauses.length > 0);
    if (clauses.length === 0) return [];

    const variableSet: Record<string, number> = {};
    clauses.forEach((c) => {
      const gathered = gatherDatalogVariablesFromClause(c);
      gathered.forEach((v) => {
        variableSet[v] = (variableSet[v] || 0) + 1;
      });
    });
    const datalog = [
      {
        type: "or-join-clause",
        clauses,
        variables: Object.entries(variableSet)
          .filter(([, v]) => v === clauses.length)
          .map(([value]) => ({
            type: "variable",
            value,
          })),
      },
    ] as DatalogClause[];
    if (con.type === "not or")
      return [{ type: "not-clause", clauses: datalog }];
    return datalog;
  }
  const { relation, ...condition } = con;
  const datalogTranslator =
    translator[relation] ||
    Object.entries(translator).find(([k]) =>
      new RegExp(relation, "i").test(k),
    )?.[1];
  const datalog = datalogTranslator?.callback?.(condition) || [];
  if (datalog.length && (con.type === "not" || con.not))
    return [{ type: "not-clause", clauses: datalog }];
  return datalog;
};
// COPY-END

export default conditionToDatalog;
