// Reified ("stored") discourse relations — shared contract.
//
// A relation is one block per edge, a direct child of the relations page, whose
// :block/string equals its own :block/uid and whose payload lives entirely in
// :block/props. See HANDOFF-discourse-relations.md for the full contract and the
// two silent-failure traps.

export const RELATIONS_PAGE_TITLE = "roam/js/discourse-graph/relations";

/** Prop namespace the Roam extension writes under (createReifiedBlock.ts). */
export const DISCOURSE_GRAPH_PROP = "discourse-graph";

/** A single stored relation record as it exists in the graph. */
export type StoredRelation = {
  /** uid of the relation block itself */
  relationUid: string;
  sourceUid: string;
  destinationUid: string;
  /** uid of the relation-definition block; equals InternalDiscourseRelationType.id */
  hasSchema: string;
};

/** A stored relation resolved against the grammar, from one node's point of view. */
export type ResolvedStoredRelation = {
  relationUid: string;
  /** Label to show the user: the schema label forward, its complement backward. */
  label: string;
  direction: "forward" | "complement";
  /** The node at the other end. */
  targetUid: string;
  targetTitle: string;
  hasSchema: string;
};

// Datalog note: props MUST be destructured inside the query with keyword `get`
// constants. Returning `?props` itself yields [null] via data.fast.q, and a
// string-keyed get ("discourse-graph") silently returns zero rows. Both failures
// look exactly like "there is no data".
const PROPS_CLAUSES = `
  [?relPage :node/title "${RELATIONS_PAGE_TITLE}"]
  [?relPage :block/children ?rel]
  [?rel :block/uid ?relUid]
  [?rel :block/props ?props]
  [(get ?props :${DISCOURSE_GRAPH_PROP}) ?dg]
  [(get ?dg :sourceUid) ?src]
  [(get ?dg :destinationUid) ?dst]
  [(get ?dg :hasSchema) ?schema]`;

/** All stored relations in the graph. */
export const ALL_RELATIONS_QUERY = `[:find ?relUid ?src ?dst ?schema
  :where${PROPS_CLAUSES}]`;

/**
 * Stored relations touching `?target` on the given side, with the far endpoint's
 * title resolved. `get-else` keeps block-endpoints (which have no :node/title)
 * from dropping out of the result set entirely.
 */
export const relationsBySideQuery = (side: "source" | "destination") => {
  const [anchor, far] =
    side === "source" ? ["?src", "?dst"] : ["?dst", "?src"];
  return `[:find ?relUid ${far} ?farTitle ?schema
  :in $ ?target
  :where${PROPS_CLAUSES}
  [(= ${anchor} ?target)]
  [?farNode :block/uid ${far}]
  [(get-else $ ?farNode :node/title "") ?farTitle]]`;
};

/** Exact-triple lookup, for dedup before writing. */
export const EXACT_TRIPLE_QUERY = `[:find ?relUid
  :in $ ?wantSrc ?wantDst ?wantSchema
  :where${PROPS_CLAUSES}
  [(= ?src ?wantSrc)]
  [(= ?dst ?wantDst)]
  [(= ?schema ?wantSchema)]]`;
