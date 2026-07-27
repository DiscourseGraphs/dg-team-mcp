// Creating reified ("stored") discourse relations.
//
// `data.block.fromMarkdown` can set neither the uid nor props, so a relation is
// written in two calls: create the block, then update it with `string == uid` and
// the props payload. If the second call fails we delete the block — the relations
// page in live graphs already carries orphans from interrupted two-step writes,
// and we should not add to them.

import type { RoamClient } from "@roam-research/roam-tools-local";
import { getPageUidByTitle } from "../roam.js";
import { findExactRelation } from "./read.js";
import {
  DISCOURSE_GRAPH_PROP,
  RELATIONS_PAGE_TITLE,
  type StoredRelation,
} from "./model.js";

/**
 * Resolve the relations page, creating it if the graph has never stored one.
 * The extension treats this page as config, so creating it is safe and is what
 * the extension itself does on first write.
 */
export const resolveRelationsPageUid = async (
  client: RoamClient,
): Promise<string> => {
  const existing = await getPageUidByTitle(client, RELATIONS_PAGE_TITLE);
  if (existing) return existing;

  await client.call("data.page.fromMarkdown", [
    { page: { title: RELATIONS_PAGE_TITLE }, "markdown-string": "" },
  ]);
  const created = await getPageUidByTitle(client, RELATIONS_PAGE_TITLE);
  if (!created) {
    throw new Error(`Could not create the "${RELATIONS_PAGE_TITLE}" page.`);
  }
  return created;
};

/** Delete a stored relation block. Used by the smoke script and for rollback. */
export const deleteStoredRelation = async (
  client: RoamClient,
  relationUid: string,
): Promise<void> => {
  await client.call("data.block.delete", [{ block: { uid: relationUid } }]);
};

/**
 * Write one directed relation record. Callers are responsible for validating
 * that `hasSchema` resolves — this is the mutation primitive only.
 *
 * Never write the complement as a second record: the extension resolves reverse
 * direction at query time, and a stored complement would double-count.
 */
const createStoredRelation = async (
  client: RoamClient,
  triple: Omit<StoredRelation, "relationUid">,
): Promise<string> => {
  const parentUid = await resolveRelationsPageUid(client);

  const created = await client.call<{ uids?: string[] }>(
    "data.block.fromMarkdown",
    [
      {
        location: { "parent-uid": parentUid, order: "last" },
        "markdown-string": "-",
      },
    ],
  );
  const uid = created.result?.uids?.[0];
  if (!uid) {
    throw new Error(
      `Could not create a relation block under "${RELATIONS_PAGE_TITLE}" (no uid returned).`,
    );
  }

  try {
    await client.call("data.block.update", [
      {
        block: {
          uid,
          // Contract: the block's text is its own uid. It is never read by a human.
          string: uid,
          props: {
            [DISCOURSE_GRAPH_PROP]: {
              sourceUid: triple.sourceUid,
              destinationUid: triple.destinationUid,
              hasSchema: triple.hasSchema,
            },
          },
        },
      },
    ]);
  } catch (error) {
    // Roll back rather than leave a props-less orphan on the relations page.
    await deleteStoredRelation(client, uid).catch(() => undefined);
    throw error;
  }

  return uid;
};

/**
 * The write entry point: returns the existing record when the exact directed
 * triple is already stored, and writes it otherwise. Dedup-before-write is
 * module policy (README #2), enforced here rather than left to callers.
 */
export const ensureStoredRelation = async (
  client: RoamClient,
  triple: Omit<StoredRelation, "relationUid">,
): Promise<{ created: boolean; relationUid: string }> => {
  const existing = await findExactRelation(client, triple);
  if (existing) return { created: false, relationUid: existing };
  return { created: true, relationUid: await createStoredRelation(client, triple) };
};
