// get_candidate_nodes: blocks staged with a node type's candidate tag.
//
// Candidate nodes are the informal tier of the discourse graph: BLOCKS tagged
// with a per-type candidate hashtag (e.g. `#evd-candidate`), not yet promoted
// to formal `[[TYPE]] - …` pages. get_all_discourse_nodes matches only the
// formal pages, so candidates are invisible to it by construction.
//
// The tag-to-type mapping is NOT derivable from the type's format — dg-team
// alone has `#flow-candidate` (FLO), `#up-candidate` (UserPilot), and
// `painpoint` (PainPoint). It is a per-node-type setting in the Discourse
// Graph config that discourse-config.ts already discovers as `tag`; that
// config value is the single source of truth here.
//
// A tag reference is a page reference: `#evd-candidate`, `#[[evd-candidate]]`
// and `[[evd-candidate]]` all put the page entity in the block's :block/refs,
// so one datalog shape per tag finds every candidate.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-local";
import { datalogQuery } from "../roam.js";
import { getInternalDiscourseConfig } from "../discourse-config.js";
import { getDiscourseNodeFormatInnerExpression } from "../format-expression.js";
import type { InternalDiscourseNodeType } from "../types.js";

export const GetCandidateNodesSchema = z.object({
  graph: z
    .string()
    .optional()
    .describe(
      "Graph name or nickname. Auto-selects if only one graph is configured.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      "Restrict to one node type: type id, name (e.g. Evidence), format tag (e.g. EVD), or the candidate tag itself (e.g. evd-candidate).",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Query one explicit candidate tag (page title, `#` optional) even if no configured node type declares it. Overrides `type`.",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "ISO date string. Only return candidate blocks edited after this date. Defaults to all time.",
    ),
});

export const getCandidateNodesDescription =
  "Get candidate discourse nodes: blocks tagged with a node type's candidate " +
  "tag (e.g. #evd-candidate) that have not been promoted to formal node pages. " +
  "These are invisible to get_all_discourse_nodes, which only matches formal " +
  "`[[TYPE]] - …` pages. Tags come from each node type's configured candidate " +
  "tag. Each result includes the block text, uid, page, author, timestamps, " +
  "and a `references_formal_node` heuristic (true when the block's text " +
  "already contains a reference matching the type's title format — often a " +
  "sign it was promoted in place).";

/**
 * Config `tag` values vary in shape across graphs: "#evd-candidate",
 * "evd-candidate", "#[[evd-candidate]]". Normalize to the bare page title the
 * tag references.
 */
export const normalizeCandidateTag = (raw: string): string =>
  raw
    .trim()
    .replace(/^#/, "")
    .replace(/^\[\[(.*)\]\]$/s, "$1")
    .trim();

/** The "EVD" in "[[EVD]] - {content}"; undefined for formats like "Project/{content}". */
const formatTag = (format: string): string | undefined =>
  format.match(/^\[\[([^\]]+)\]\]/)?.[1];

/** Resolve a user-supplied type ref against the configured node types. */
export const resolveCandidateType = (
  nodes: InternalDiscourseNodeType[],
  ref: string,
): InternalDiscourseNodeType | undefined => {
  const lower = ref.trim().toLowerCase();
  return (
    nodes.find((n) => n.typeId === ref) ??
    nodes.find((n) => n.name.toLowerCase() === lower) ??
    nodes.find((n) => formatTag(n.format)?.toLowerCase() === lower) ??
    nodes.find((n) => {
      const tag = normalizeCandidateTag(n.tag).toLowerCase();
      return tag !== "" && (tag === lower || tag === `${lower}-candidate`);
    })
  );
};

/**
 * Heuristic: does the block's text contain a reference matching the type's
 * title format (e.g. `[[EVD]] - …`)? Promotion usually rewrites the candidate
 * block into a reference to the new node page, so true often means "already
 * promoted in place". It can also be a passing mention, and for loose formats
 * (Source's `@{content}`) it over-matches — a hint, not a verdict.
 */
export const referencesFormalNode = (text: string, format: string): boolean => {
  if (!format || !text) return false;
  return new RegExp(getDiscourseNodeFormatInnerExpression(format), "s").test(
    text,
  );
};

/**
 * All blocks referencing the tag page. `?since` bounds by edit time, matching
 * get_all_discourse_nodes' since semantics; author fields follow its shape,
 * except author and create-time are optional here — hard :create/user or
 * :create/time clauses silently drop old imported blocks that lack them
 * (2 of 541 iss-candidates in dg-team), and a review tool must return every
 * candidate. Missing timestamps come back as "0".
 */
export const candidateBlocksQuery = `[
  :find ?uid ?string ?createTime ?editTime ?author-local-id ?author-name ?page-uid ?page-title
  :in $ ?tag-title ?since
  :where
    [?tag :node/title ?tag-title]
    [?b :block/refs ?tag]
    [?b :block/uid ?uid]
    [?b :block/string ?string]
    [(get-else $ ?b :create/time 0) ?createTime]
    [(get-else $ ?b :edit/time ?createTime) ?editTime]
    (or-join [?b ?author-local-id ?author-name]
      (and [?b :create/user ?user-eid]
           [(get-else $ ?user-eid :user/uid "") ?author-local-id]
           [(get-else $ ?user-eid :user/display-name "Anonymous User") ?author-name])
      (and [(missing? $ ?b :create/user)]
           [(ground "") ?author-local-id]
           [(ground "Anonymous User") ?author-name]))
    [?b :block/page ?p]
    [?p :block/uid ?page-uid]
    [(get-else $ ?p :node/title "") ?page-title]
    [(>= ?editTime ?since)]
]`;

type CandidateTuple = [
  string, // uid
  string, // string
  number, // create time
  number, // edit time
  string, // author local id
  string, // author name
  string, // page uid
  string, // page title
];

type CandidateRow = {
  uid: string;
  text: string;
  tag: string;
  node_type_id?: string;
  node_type?: string;
  page_uid: string;
  page_title: string;
  created: string;
  last_modified: string;
  author_local_id: string;
  author_name: string;
  references_formal_node: boolean;
};

export const handleGetCandidateNodes = async (
  client: RoamClient,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> => {
  const p = GetCandidateNodesSchema.parse(args);
  const config = await getInternalDiscourseConfig(client);
  const nodes = config.nodes.filter((n) => n.backedBy !== "default");

  // Each target is one tag page to query, with the node type(s) declaring it
  // (an explicit `tag` may be declared by none).
  let targets: Array<{ tag: string; types: InternalDiscourseNodeType[] }>;

  if (p.tag) {
    const tag = normalizeCandidateTag(p.tag);
    if (!tag) throw new Error("`tag` is empty after normalization.");
    targets = [
      {
        tag,
        types: nodes.filter(
          (n) => normalizeCandidateTag(n.tag).toLowerCase() === tag.toLowerCase(),
        ),
      },
    ];
  } else {
    let tagged = nodes.filter((n) => normalizeCandidateTag(n.tag) !== "");
    if (p.type) {
      const resolved = resolveCandidateType(nodes, p.type);
      if (!resolved) {
        throw new Error(
          `Unknown node type "${p.type}". Available: ${nodes
            .map((n) => `${n.name} (${n.typeId})`)
            .join(", ")}`,
        );
      }
      if (normalizeCandidateTag(resolved.tag) === "") {
        throw new Error(
          `Node type "${resolved.name}" has no candidate tag configured. Types with tags: ${tagged
            .map((n) => `${n.name} (#${normalizeCandidateTag(n.tag)})`)
            .join(", ")}`,
        );
      }
      tagged = [resolved];
    }
    const byTag = new Map<string, InternalDiscourseNodeType[]>();
    for (const n of tagged) {
      const tag = normalizeCandidateTag(n.tag);
      byTag.set(tag, [...(byTag.get(tag) ?? []), n]);
    }
    targets = [...byTag.entries()].map(([tag, types]) => ({ tag, types }));
  }

  const sinceMs = p.since ? new Date(p.since).getTime() : 0;
  const candidates: CandidateRow[] = [];

  await Promise.all(
    targets.map(async ({ tag, types }) => {
      const rows = await datalogQuery<CandidateTuple>(
        client,
        candidateBlocksQuery,
        tag,
        sinceMs,
      );
      const primary = types[0];
      for (const row of rows) {
        if (row == null) continue;
        const [
          uid,
          text,
          created,
          lastModified,
          authorLocalId,
          authorName,
          pageUid,
          pageTitle,
        ] = row;
        candidates.push({
          uid,
          text,
          tag,
          node_type_id: primary?.typeId,
          node_type: primary?.name,
          page_uid: pageUid,
          page_title: pageTitle,
          created: String(created),
          last_modified: String(lastModified),
          author_local_id: authorLocalId,
          author_name: authorName,
          references_formal_node: primary
            ? referencesFormalNode(text, primary.format)
            : false,
        });
      }
    }),
  );

  candidates.sort((a, b) => Number(b.last_modified) - Number(a.last_modified));

  const tagSummaries = targets
    .map(({ tag, types }) => ({
      tag,
      node_type_id: types[0]?.typeId,
      node_type: types[0]?.name,
      count: candidates.filter((c) => c.tag === tag).length,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { count: candidates.length, tags: tagSummaries, candidates },
          null,
          2,
        ),
      },
    ],
  };
};
