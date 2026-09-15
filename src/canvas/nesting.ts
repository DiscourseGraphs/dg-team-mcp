// Nested sub-canvas portals: tldraw page CRUD plus the portal contract shared
// with the Roam plugin (DiscourseGraphs/discourse-graph#1308, ENG-2150).
//
// The contract, pinned by the plugin's nestedPagesCompat.test.ts: a portal is
// a NATIVE geo rectangle carrying meta.dgSubpage = { targetPageId, accent,
// title }, and the page hierarchy lives in page.meta.dgNested = { parentPageId,
// ownerShapeId }. There is deliberately NO custom shape type: an unknown shape
// type makes old clients' loadSnapshot throw and blanks the whole canvas,
// while unknown meta is tolerated by every client version. Old clients render
// a portal as a labeled "⤵ page name" rectangle.

import { nanoid } from "nanoid";
import { getIndexAbove } from "@tldraw/utils";
import type { SerializedStore, TldrawRecord } from "./model.js";
import { listPages, shapeAbsoluteOrigin, shapePageId } from "./records.js";

/** tldraw's editor.options.maxPages default; the app enforces it silently. */
export const MAX_TLDRAW_PAGES = 40;

export const DEFAULT_PORTAL_ACCENT = "#6d5ae0";
export const DEFAULT_PORTAL_WIDTH = 460;
export const DEFAULT_PORTAL_HEIGHT = 340;

export const newPageId = (): string => `page:${nanoid()}`;

/** The label old (feature-less) clients see on the portal rectangle. */
export const portalLabel = (pageName: string): string => `⤵ ${pageName}`;

export type SubpageMeta = {
  targetPageId: string;
  accent?: string;
  title?: string;
  subtitle?: string;
};

export type NestedPageMeta = {
  parentPageId: string;
  ownerShapeId?: string;
};

/** Parse a shape's portal meta; a portal requires a string targetPageId. */
export const getSubpageMeta = (record: TldrawRecord): SubpageMeta | null => {
  const meta = record.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const sub = (meta as { dgSubpage?: unknown }).dgSubpage;
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null;
  const parsed = sub as SubpageMeta;
  return typeof parsed.targetPageId === "string" ? parsed : null;
};

/** Parse a page's lineage meta; requires a string parentPageId. */
export const getNestedPageMeta = (record: TldrawRecord): NestedPageMeta | null => {
  const meta = record.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const nested = (meta as { dgNested?: unknown }).dgNested;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const parsed = nested as NestedPageMeta;
  return typeof parsed.parentPageId === "string" ? parsed : null;
};

/** Every portal shape in the store, wherever it lives. */
export const listSubpagePortals = (
  store: SerializedStore,
): Array<{ shape: TldrawRecord; targetPageId: string }> => {
  const portals: Array<{ shape: TldrawRecord; targetPageId: string }> = [];
  for (const record of Object.values(store)) {
    if (record.typeName !== "shape") continue;
    const meta = getSubpageMeta(record);
    if (meta) portals.push({ shape: record, targetPageId: meta.targetPageId });
  }
  return portals;
};

/** Throw before creating a page tldraw would silently refuse (cap 40). */
export const assertPageCapacity = (store: SerializedStore): void => {
  const count = listPages(store).length;
  if (count >= MAX_TLDRAW_PAGES) {
    throw new Error(
      `This canvas already has ${count} tldraw pages, the app's cap of ${MAX_TLDRAW_PAGES}. Delete a page first.`,
    );
  }
};

/** A unique page name: "Name", else "Name 2", "Name 3", … (case-insensitive).
 *  `excludePageId` lets a rename keep its own current name. */
export const dedupePageName = (
  store: SerializedStore,
  name: string,
  excludePageId?: string,
): string => {
  const taken = new Set(
    listPages(store)
      .filter((p) => p.id !== excludePageId)
      .map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

/**
 * Author a page record after the last page in board order. Does NOT insert it
 * into the store or dedupe the name; callers run assertPageCapacity and
 * dedupePageName first.
 */
export const createPageRecord = ({
  store,
  name,
  meta = {},
  id = newPageId(),
}: {
  store: SerializedStore;
  name: string;
  meta?: TldrawRecord["meta"];
  id?: string;
}): TldrawRecord => {
  const pages = listPages(store);
  const lastIndex = pages[pages.length - 1]?.index;
  return {
    id,
    typeName: "page",
    name,
    index: getIndexAbove(lastIndex as never) as string,
    meta,
  };
};

/**
 * Rewrite the visible label and stored title of every portal targeting a page,
 * after that page is renamed. Returns how many portals changed. This is what
 * keeps old-client labels honest, since only live clients read the name.
 */
export const syncPortalLabels = (
  store: SerializedStore,
  targetPageId: string,
  newName: string,
): number => {
  let changed = 0;
  for (const { shape, targetPageId: target } of listSubpagePortals(store)) {
    if (target !== targetPageId) continue;
    (shape.props as { text?: string }).text = portalLabel(newName);
    const meta = shape.meta as { dgSubpage: SubpageMeta };
    meta.dgSubpage = { ...meta.dgSubpage, title: newName };
    changed += 1;
  }
  return changed;
};

/**
 * Delete a page and everything on it (shapes and their bindings). Portals
 * elsewhere that pointed at the page are NEVER cascaded: live clients render
 * them as "target page not found", and the returned ids let a caller re-link
 * or clean up deliberately. Refuses to delete the last page.
 */
export const deletePage = (
  store: SerializedStore,
  pageId: string,
): { removed: string[]; orphanedPortals: string[] } => {
  const pages = listPages(store);
  if (!store[pageId] || store[pageId]?.typeName !== "page") {
    throw new Error(`No page record "${pageId}" on this canvas.`);
  }
  if (pages.length <= 1) {
    throw new Error("Refusing to delete the last page of a canvas.");
  }
  const removed: string[] = [];
  for (const record of Object.values(store)) {
    if (record.typeName === "shape" && shapePageId(store, record.id) === pageId) {
      removed.push(record.id);
    }
  }
  const removedSet = new Set(removed);
  for (const record of Object.values(store)) {
    if (record.typeName !== "binding") continue;
    if (removedSet.has(String(record.fromId)) || removedSet.has(String(record.toId))) {
      removed.push(record.id);
      removedSet.add(record.id);
    }
  }
  for (const id of removed) delete store[id];
  delete store[pageId];
  const orphanedPortals = listSubpagePortals(store)
    .filter(({ targetPageId }) => targetPageId === pageId)
    .map(({ shape }) => shape.id);
  return { removed, orphanedPortals };
};

/**
 * Re-parent top-level shapes onto another page, keeping their coordinates.
 * Shapes inside a moved frame or group follow it (their parentId is the
 * container, which is what moves). A bound arrow moves along automatically
 * when every shape it binds to is part of the move; a move that would leave a
 * bound arrow spanning two pages is refused, matching canvas_connect's
 * cross-page guard.
 */
export const moveShapesToPage = (
  store: SerializedStore,
  shapeIds: string[],
  targetPageId: string,
): { moved: number; arrowsMoved: number } => {
  if (!store[targetPageId] || store[targetPageId]?.typeName !== "page") {
    throw new Error(`No page record "${targetPageId}" on this canvas.`);
  }
  const moving = new Set<string>();
  for (const id of shapeIds) {
    const shape = store[id];
    if (!shape || shape.typeName !== "shape") throw new Error(`Shape not found: ${id}`);
    moving.add(id);
  }
  // Descendants of a moving container count as moving for the arrow check.
  const movesWithShape = (id: string): boolean => {
    let cur: TldrawRecord | undefined = store[id];
    const seen = new Set<string>();
    while (cur && cur.typeName === "shape" && !seen.has(cur.id)) {
      if (moving.has(cur.id)) return true;
      seen.add(cur.id);
      const parentId: string = typeof cur.parentId === "string" ? cur.parentId : "";
      cur = parentId.startsWith("shape:") ? store[parentId] : undefined;
    }
    return false;
  };

  // Arrows bound to moved shapes: bring them when all endpoints move, refuse a split.
  const arrowEndpoints = new Map<string, string[]>();
  for (const record of Object.values(store)) {
    if (record.typeName !== "binding") continue;
    const arrowId = String(record.fromId);
    const boundId = String(record.toId);
    if (!arrowEndpoints.has(arrowId)) arrowEndpoints.set(arrowId, []);
    arrowEndpoints.get(arrowId)!.push(boundId);
  }
  const arrowsToMove: string[] = [];
  for (const [arrowId, endpoints] of arrowEndpoints) {
    if (movesWithShape(arrowId)) continue; // moves as part of a container anyway
    const movingEndpoints = endpoints.filter(movesWithShape);
    if (movingEndpoints.length === 0) continue;
    if (movingEndpoints.length < endpoints.length) {
      throw new Error(
        `Moving these shapes would leave bound arrow ${arrowId} spanning two pages. Move both endpoints together, or delete the arrow first.`,
      );
    }
    if (!moving.has(arrowId)) arrowsToMove.push(arrowId);
  }

  const reparent = (id: string) => {
    const shape = store[id]!;
    const parentId = typeof shape.parentId === "string" ? shape.parentId : "";
    if (parentId.startsWith("page:")) {
      shape.parentId = targetPageId;
      return;
    }
    // A shape inside a moving container keeps its container-local parentId
    // and coordinates; one inside a container that STAYS pops out to the
    // target page at its absolute position.
    if (parentId.startsWith("shape:") && !movesWithShape(parentId)) {
      const origin = shapeAbsoluteOrigin(store, id);
      shape.parentId = targetPageId;
      shape.x = origin.x;
      shape.y = origin.y;
    }
  };
  for (const id of moving) reparent(id);
  for (const id of arrowsToMove) reparent(id);
  return { moved: moving.size, arrowsMoved: arrowsToMove.length };
};
