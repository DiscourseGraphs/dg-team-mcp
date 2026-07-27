// Tool: create_discourse_relation
// Write one reified ("stored") discourse relation between two existing nodes.
//
// Relation labels are NOT unique in the grammar — sandbox-dg has two "Supports"
// and two "Addresses" definitions differing only in their endpoint types. So the
// label alone can be ambiguous; this tool disambiguates by the source and
// destination node types and refuses (rather than guessing) when that is not
// enough.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-local";
import { errorResult, textResult } from "@roam-research/roam-tools-core";
import { dedupeRelations, getInternalDiscourseConfig } from "../discourse-config.js";
import { datalogQuery } from "../roam.js";
import type { InternalDiscourseRelationType } from "../types.js";
import { findDiscourseNodeType } from "./get-relationships.js";
import { findExactRelation } from "../relations/read.js";
import { ensureStoredRelation } from "../relations/write.js";

export const CreateRelationSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
  source_uid: z.string().describe("Page UID of the source node."),
  destination_uid: z.string().describe("Page UID of the destination node."),
  relation: z
    .string()
    .describe(
      "Relation label, e.g. 'Supports'. May also be a complement label " +
        "(e.g. 'Supported By'), in which case the stored record is written in " +
        "the canonical forward direction automatically.",
    ),
  relation_schema_uid: z
    .string()
    .optional()
    .describe(
      "UID of a specific relation definition, to disambiguate when the graph " +
        "defines the same label more than once.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Resolve and validate everything, report what would be written, but do " +
        "not write. Default false.",
    ),
});

export const createRelationDescription =
  "Create a typed discourse relation between two existing discourse nodes " +
  "(e.g. assert that a piece of Evidence Supports a Claim). Writes a single " +
  "stored relation record; the reverse direction is derived automatically and " +
  "must not be created separately. Validates that the relation is legal " +
  "between the two node types, and is a no-op if the relation already exists. " +
  "Use dry_run to preview the resolution first.";

const eq = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** A relation type matched against the requested label and endpoint types. */
type Candidate = {
  relation: InternalDiscourseRelationType;
  /**
   * "forward" writes (source_uid -> destination_uid). "complement" means the
   * user named the reverse label, so the stored record flips the endpoints.
   */
  orientation: "forward" | "complement";
};

const typeMatches = (declared: string, actual: string | null) =>
  declared === "*" || (actual !== null && declared === actual);

const describeCandidate = (
  { relation, orientation }: Candidate,
  nodeName: (typeId: string) => string,
) => ({
  relation_schema_uid: relation.id,
  label: relation.label,
  complement: relation.complement,
  source_type: nodeName(relation.source),
  destination_type: nodeName(relation.destination),
  writes: orientation === "forward" ? "source -> destination" : "destination -> source (label given was the complement)",
});

export const handleCreateRelation = async (
  client: RoamClient,
  args: {
    source_uid: string;
    destination_uid: string;
    relation: string;
    relation_schema_uid?: string;
    dry_run?: boolean;
  },
) => {
  const {
    source_uid: sourceUid,
    destination_uid: destinationUid,
    relation: label,
    relation_schema_uid: schemaUid,
    dry_run: dryRun = false,
  } = args;

  if (sourceUid === destinationUid) {
    return errorResult(
      `Refusing to relate ${sourceUid} to itself. Source and destination must differ.`,
    );
  }

  // Both endpoints must exist as blocks/pages in the graph; the check depends
  // only on the args, so it runs alongside the config fetch.
  const [config, present] = await Promise.all([
    getInternalDiscourseConfig(client),
    datalogQuery<[string]>(
      client,
      `[:find ?uid :in $ [?uid ...] :where [?b :block/uid ?uid]]`,
      [sourceUid, destinationUid],
    ),
  ]);

  const relationDefs = dedupeRelations(config.relations);
  if (!relationDefs.length) {
    return errorResult(
      "This graph has no discourse relation types configured under " +
        "roam/js/discourse-graph > grammar > relations, so no relation can be created.",
    );
  }

  const nodeName = (typeId: string) =>
    typeId === "*"
      ? "Any"
      : config.nodes.find((n) => n.typeId === typeId)?.name || typeId;

  const found = new Set(present.map(([u]) => u));
  const missing = [sourceUid, destinationUid].filter((u) => !found.has(u));
  if (missing.length) {
    return errorResult(`No such uid in this graph: ${missing.join(", ")}`);
  }

  const [sourceType, destinationType] = await Promise.all([
    findDiscourseNodeType({ client, uid: sourceUid, nodes: config.nodes }),
    findDiscourseNodeType({ client, uid: destinationUid, nodes: config.nodes }),
  ]);

  const untyped = [
    ...(sourceType ? [] : [`source ${sourceUid}`]),
    ...(destinationType ? [] : [`destination ${destinationUid}`]),
  ];
  if (untyped.length) {
    return errorResult(
      `Not a recognized discourse node: ${untyped.join(", ")}. ` +
        "Relations can only connect nodes whose titles match a configured " +
        "discourse node type.",
    );
  }

  // Match on the forward label, and on the complement label with flipped
  // endpoints, always checking the declared endpoint types. (Read-side
  // counterpart: register-discourse-translators.ts does the same label +
  // declared-type matching, but case-sensitively — keep them in sight of each
  // other if either changes.)
  const candidates: Candidate[] = [];
  for (const relation of relationDefs) {
    if (
      eq(relation.label, label) &&
      typeMatches(relation.source, sourceType) &&
      typeMatches(relation.destination, destinationType)
    ) {
      candidates.push({ relation, orientation: "forward" });
    }
    if (
      relation.complement &&
      eq(relation.complement, label) &&
      typeMatches(relation.source, destinationType) &&
      typeMatches(relation.destination, sourceType)
    ) {
      candidates.push({ relation, orientation: "complement" });
    }
  }

  const narrowed = schemaUid
    ? candidates.filter((c) => c.relation.id === schemaUid)
    : candidates;

  if (!narrowed.length) {
    if (schemaUid) {
      return errorResult(
        `relation_schema_uid ${schemaUid} does not match a "${label}" relation valid between these node types.`,
      );
    }
    const sameLabel = relationDefs.filter(
      (r) => eq(r.label, label) || (r.complement && eq(r.complement, label)),
    );
    return errorResult(
      sameLabel.length
        ? `"${label}" exists in the grammar but not between ${nodeName(
            sourceType!,
          )} and ${nodeName(destinationType!)}. Defined as: ` +
            JSON.stringify(
              sameLabel.map((r) => ({
                label: r.label,
                source_type: nodeName(r.source),
                destination_type: nodeName(r.destination),
              })),
            )
        : `No relation labelled "${label}" in this graph. Available: ` +
            JSON.stringify([...new Set(relationDefs.map((r) => r.label))]),
    );
  }

  if (narrowed.length > 1) {
    return errorResult(
      `"${label}" is ambiguous between ${nodeName(sourceType!)} and ${nodeName(
        destinationType!,
      )} — this graph defines it ${narrowed.length} times. ` +
        "Re-run with relation_schema_uid set to one of: " +
        JSON.stringify(
          narrowed.map((c) => describeCandidate(c, nodeName)),
          null,
          2,
        ),
    );
  }

  const chosen = narrowed[0];
  // The stored record is always written in the schema's own direction.
  const [recordSource, recordDestination] =
    chosen.orientation === "forward"
      ? [sourceUid, destinationUid]
      : [destinationUid, sourceUid];
  const triple = {
    sourceUid: recordSource,
    destinationUid: recordDestination,
    hasSchema: chosen.relation.id,
  };

  const alreadyExists = (relationUid: string) => ({
    created: false,
    reason: "already_exists",
    relation_uid: relationUid,
    ...triple,
    label: chosen.relation.label,
  });

  if (dryRun) {
    const existing = await findExactRelation(client, triple);
    return textResult(
      existing
        ? alreadyExists(existing)
        : {
            created: false,
            reason: "dry_run",
            would_write: {
              ...triple,
              label: chosen.relation.label,
              source_type: nodeName(chosen.relation.source),
              destination_type: nodeName(chosen.relation.destination),
            },
          },
    );
  }

  const { created, relationUid } = await ensureStoredRelation(client, triple);
  if (!created) return textResult(alreadyExists(relationUid));

  return textResult({
    created: true,
    relation_uid: relationUid,
    ...triple,
    label: chosen.relation.label,
    note:
      "Stored relation written. The reverse direction " +
      `("${chosen.relation.complement}") is derived at query time and must not ` +
      "be created as a second record.",
  });
};
