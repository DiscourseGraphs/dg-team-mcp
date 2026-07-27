// Reading reified ("stored") discourse relations.
//
// The Roam extension gates these behind a per-user `use-reified-relations`
// setting, but that only governs the extension's own UI — the records are always
// present in the graph, so we read them unconditionally.

import type { RoamClient } from "@roam-research/roam-tools-local";
import { datalogQuery } from "../roam.js";
import type { InternalDiscourseRelationType } from "../types.js";
import {
  ALL_RELATIONS_QUERY,
  EXACT_TRIPLE_QUERY,
  relationsBySideQuery,
  type ResolvedStoredRelation,
  type StoredRelation,
} from "./model.js";

export const getAllStoredRelations = async (
  client: RoamClient,
): Promise<StoredRelation[]> => {
  const rows = await datalogQuery<[string, string, string, string]>(
    client,
    ALL_RELATIONS_QUERY,
  );
  return rows.map(([relationUid, sourceUid, destinationUid, hasSchema]) => ({
    relationUid,
    sourceUid,
    destinationUid,
    hasSchema,
  }));
};

/** True when a stored relation already exists for this exact directed triple. */
export const findExactRelation = async (
  client: RoamClient,
  triple: { sourceUid: string; destinationUid: string; hasSchema: string },
): Promise<string | undefined> => {
  const rows = await datalogQuery<[string]>(
    client,
    EXACT_TRIPLE_QUERY,
    triple.sourceUid,
    triple.destinationUid,
    triple.hasSchema,
  );
  return rows[0]?.[0];
};

export type StoredRelationsForNode = {
  relations: ResolvedStoredRelation[];
  /**
   * Records pointing at a schema uid that no longer resolves in the grammar.
   * Common in the wild (grammar edits orphan them); the extension drops these
   * with a console.warn, and so do we — but we report the count rather than
   * hiding it, since a silent drop reads as "no relations".
   */
  staleSchemaCount: number;
};

/**
 * Stored relations touching `uid`, in both directions, resolved against the
 * grammar. Forward records (uid is the source) are labelled with the schema
 * label; backward records (uid is the destination) with its complement.
 */
export const getStoredRelationsForNode = async (
  client: RoamClient,
  uid: string,
  relations: InternalDiscourseRelationType[],
): Promise<StoredRelationsForNode> => {
  const schemaById = new Map(relations.map((r) => [r.id, r]));

  const read = async (side: "source" | "destination") => {
    const rows = await datalogQuery<[string, string, string, string]>(
      client,
      relationsBySideQuery(side),
      uid,
    );
    return rows.map(([relationUid, targetUid, targetTitle, hasSchema]) => ({
      relationUid,
      targetUid,
      targetTitle,
      hasSchema,
      direction: (side === "source" ? "forward" : "complement") as
        | "forward"
        | "complement",
    }));
  };

  const [forward, backward] = await Promise.all([
    read("source"),
    read("destination"),
  ]);

  let staleSchemaCount = 0;
  const resolved: ResolvedStoredRelation[] = [];

  for (const row of [...forward, ...backward]) {
    const schema = schemaById.get(row.hasSchema);
    if (!schema) {
      staleSchemaCount += 1;
      continue;
    }
    // Self-referential records carry no information for the caller.
    if (row.targetUid === uid) continue;
    resolved.push({
      ...row,
      label: row.direction === "forward" ? schema.label : schema.complement,
    });
  }

  return { relations: resolved, staleSchemaCount };
};
