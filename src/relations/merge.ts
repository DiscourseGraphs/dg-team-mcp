// Merging inferred and stored relations — the union half of this module's
// contract (see README: "Two ways a relation can exist").

import type { ResolvedStoredRelation } from "./model.js";

/** Minimal shape the merge needs from an inferred result; query results satisfy it. */
export type MergeableResult = { uid: string; text: string } & Record<
  string,
  unknown
>;

export type RelationGroup = {
  relation: string;
  direction: "forward" | "complement";
  results: Array<MergeableResult & { origin: string; relation_uid?: string }>;
};

/**
 * Union the two ways a relation can exist in a graph: matched by the grammar's
 * triple pattern ("inferred"), or written as an explicit record ("stored").
 * A node reached both ways is reported once, tagged "both" — the same edge, not
 * two edges. Callers need the distinction because only stored edges have a
 * relation_uid that can be edited or deleted.
 */
export const mergeStoredRelations = (
  inferred: Array<{
    relation: string;
    direction: "forward" | "complement";
    results: MergeableResult[];
  }>,
  stored: ResolvedStoredRelation[],
): RelationGroup[] => {
  const keyOf = (relation: string, direction: string) =>
    `${relation}::${direction}`;
  const grouped = new Map<string, RelationGroup>();

  for (const group of inferred) {
    grouped.set(keyOf(group.relation, group.direction), {
      relation: group.relation,
      direction: group.direction,
      results: group.results.map((r) => ({ ...r, origin: "inferred" })),
    });
  }

  for (const rel of stored) {
    const key = keyOf(rel.label, rel.direction);
    const group = grouped.get(key) ?? {
      relation: rel.label,
      direction: rel.direction,
      results: [],
    };
    const hit = group.results.find((r) => r.uid === rel.targetUid);
    if (hit) {
      hit.origin = "both";
      hit.relation_uid = rel.relationUid;
    } else {
      group.results.push({
        uid: rel.targetUid,
        text: rel.targetTitle,
        origin: "stored",
        relation_uid: rel.relationUid,
      });
    }
    grouped.set(key, group);
  }

  return [...grouped.values()].filter((g) => g.results.length > 0);
};
