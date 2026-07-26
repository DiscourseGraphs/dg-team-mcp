// Creating reified ("stored") discourse relations.
//
// `data.block.fromMarkdown` can set neither the uid nor props, so a relation is
// written in two calls: create the block, then update it with `string == uid` and
// the props payload. If the second call fails we delete the block — the relations
// page in live graphs already carries orphans from interrupted two-step writes,
// and we should not add to them.

import type { RoamClient } from "@roam-research/roam-tools-local";
import { getPageUidByTitle } from "../roam.js";
import {
  DISCOURSE_GRAPH_PROP,
  RELATIONS_PAGE_TITLE,
  type StoredRelation,
} from "./model.js";

/** Roam's uid alphabet; 9 chars, matching window.roamAlphaAPI.util.generateUID(). */
const UID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

const generateUid = (): string =>
  Array.from(
    { length: 9 },
    () => UID_ALPHABET[Math.floor(Math.random() * UID_ALPHABET.length)],
  ).join("");

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

  const uid = generateUid();
  await client.call("data.page.fromMarkdown", [
    { page: { title: RELATIONS_PAGE_TITLE, uid }, "markdown-string": "" },
  ]);
  const created = await getPageUidByTitle(client, RELATIONS_PAGE_TITLE);
  return created ?? uid;
};

/**
 * Write one directed relation record. Callers are responsible for dedup and for
 * validating that `hasSchema` resolves — this is the mutation primitive only.
 *
 * Never write the complement as a second record: the extension resolves reverse
 * direction at query time, and a stored complement would double-count.
 */
export const createStoredRelation = async (
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
    await client
      .call("data.block.delete", [{ block: { uid } }])
      .catch(() => undefined);
    throw error;
  }

  return uid;
};

/** Delete a stored relation block. Used by the smoke script and for rollback. */
export const deleteStoredRelation = async (
  client: RoamClient,
  relationUid: string,
): Promise<void> => {
  await client.call("data.block.delete", [{ block: { uid: relationUid } }]);
};
