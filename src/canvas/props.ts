// Page-props read/resolve for canvases.
//
// IMPORTANT: :block/props is only reachable via the `q` action. The repo's
// datalogQuery uses data.fast.q (backend index), which returns null for
// :block/props — so props reads call `q` directly here. Title/uid resolution
// uses the shared datalogQuery (strings work fine on the fast path).

import type { RoamClient } from "@roam-research/roam-tools-local";
import { datalogQuery } from "../roam.js";
import type { Json, JsonObject } from "./model.js";

/** Strip leading colon(s) from every key, recursively (mirrors the extension's normalizeProps). */
export const normalizeProps = (props: Json): Json => {
  if (typeof props !== "object" || props === null) return props;
  if (Array.isArray(props)) return props.map(normalizeProps);
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k.replace(/^:+/, ""), normalizeProps(v)]),
  );
};

const escapeDatalogString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Read and normalize a page's :block/props (via the `q` action). */
export const getPageProps = async (
  client: RoamClient,
  pageUid: string,
): Promise<JsonObject> => {
  const query = `[:find ?p :where [?e :block/uid "${escapeDatalogString(pageUid)}"] [?e :block/props ?p]]`;
  const response = await client.call<Array<Array<Json>>>("q", [query]);
  const raw = response.result?.[0]?.[0] ?? {};
  return (normalizeProps(raw) ?? {}) as JsonObject;
};

/** Resolve a page by uid or title; returns null if not found. */
export const resolvePage = async (
  client: RoamClient,
  ref: { title?: string; uid?: string },
): Promise<{ uid: string; title: string } | null> => {
  if (ref.uid) {
    const rows = await datalogQuery<[string]>(
      client,
      `[:find ?title :where [?e :block/uid "${escapeDatalogString(ref.uid)}"] [?e :node/title ?title]]`,
    );
    const title = rows?.[0]?.[0];
    return title !== undefined ? { uid: ref.uid, title } : null;
  }
  if (ref.title) {
    const rows = await datalogQuery<[string]>(
      client,
      `[:find ?uid :where [?e :node/title "${escapeDatalogString(ref.title)}"] [?e :block/uid ?uid]]`,
    );
    const uid = rows?.[0]?.[0];
    return uid ? { uid, title: ref.title } : null;
  }
  return null;
};
