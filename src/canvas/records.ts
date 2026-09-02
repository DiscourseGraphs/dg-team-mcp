// Author tldraw 2.4.6 records matching the DEPLOYED extension's conventions.
// Node shapes use the unified "discourse-node" type with the node type id in
// props.nodeTypeId. Relation arrows and their bindings still use the relation
// type id as shape.type (the client registers one util per relation id).
// Putting a node type id in shape.type makes the canvas UNOPENABLE on current
// clients: since discourse schema v5 they have no util for those types, and
// one invalid record fails validation for the whole snapshot.
// See canvas/README.md WRITE POLICY.

import { nanoid, customAlphabet } from "nanoid";
import { getIndexAbove } from "@tldraw/utils";
import type {
  CanvasNodeType,
  CanvasRelationType,
  SerializedStore,
  TldrawRecord,
} from "./model.js";

// Roam-style 9-char uid (roamAlphaAPI.util.generateUID equivalent)
const roamUidAlphabet = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  9,
);
export const generateRoamUid = (): string => roamUidAlphabet();
export const newShapeId = (): string => `shape:${nanoid()}`;
export const newBindingId = (): string => `binding:${nanoid()}`;
export const newStateId = (): string => nanoid();

export const getPageRecordId = (store: SerializedStore): string =>
  listPages(store)[0]?.id ?? "page:page";

/** Tldraw page records, sorted by fractional index (lexicographic = board order). */
export const listPages = (
  store: SerializedStore,
): Array<{ id: string; name: string; index: string }> =>
  Object.values(store)
    .filter((r) => r.typeName === "page")
    .map((r) => ({
      id: r.id,
      name: typeof r.name === "string" ? r.name : "",
      index: typeof r.index === "string" ? r.index : "",
    }))
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));

/**
 * Resolve the tldraw page a write should target. With no ref, a single-page
 * canvas targets its page; a multi-page canvas is an error (an arbitrary
 * default would drop shapes on a page the user isn't looking at).
 */
export const resolveTargetPage = (store: SerializedStore, ref?: string): string => {
  const pages = listPages(store);
  const names = pages.map((p) => `"${p.name}"`).join(", ");
  if (!ref) {
    if (pages.length === 1) return pages[0]!.id;
    throw new Error(
      `This canvas has ${pages.length} tldraw pages: ${names}. Pass \`page\` (a page name or id) to pick one.`,
    );
  }
  const byId = pages.find((p) => p.id === ref || p.id === `page:${ref}`);
  if (byId) return byId.id;
  const lower = ref.toLowerCase();
  const byName = pages.find((p) => p.name.toLowerCase() === lower);
  if (byName) return byName.id;
  throw new Error(`No tldraw page "${ref}" on this canvas. Pages: ${names}`);
};

/** The page record a shape ultimately parents to (through any frames/groups). */
export const shapePageId = (
  store: SerializedStore,
  shapeId: string,
): string | undefined => {
  let cur: TldrawRecord | undefined = store[shapeId];
  const seen = new Set<string>();
  while (cur && cur.typeName === "shape" && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parentId: string | undefined =
      typeof cur.parentId === "string" ? cur.parentId : undefined;
    if (!parentId) return undefined;
    if (parentId.startsWith("page:")) return parentId;
    cur = store[parentId];
  }
  return undefined;
};

/**
 * Absolute page-space origin of a shape, summing x/y up the parent chain.
 * A tldraw shape's x/y is relative to its parent, so a shape inside a frame
 * stores frame-local coordinates; this recovers the true canvas position.
 */
export const shapeAbsoluteOrigin = (
  store: SerializedStore,
  shapeId: string,
): { x: number; y: number } => {
  let x = 0;
  let y = 0;
  let cur: TldrawRecord | undefined = store[shapeId];
  const seen = new Set<string>();
  while (cur && cur.typeName === "shape" && !seen.has(cur.id)) {
    seen.add(cur.id);
    x += typeof cur.x === "number" ? cur.x : 0;
    y += typeof cur.y === "number" ? cur.y : 0;
    const parentId: string | undefined =
      typeof cur.parentId === "string" ? cur.parentId : undefined;
    cur = parentId && parentId.startsWith("shape:") ? store[parentId] : undefined;
  }
  return { x, y };
};

/** Find a frame shape by shape id or by its name (case-insensitive). */
export const resolveFrame = (
  store: SerializedStore,
  ref: string,
): TldrawRecord | undefined => {
  if (store[ref]?.type === "frame") return store[ref];
  const lower = ref.toLowerCase();
  return Object.values(store).find(
    (r) =>
      r.type === "frame" &&
      String((r.props as { name?: string } | undefined)?.name ?? "").toLowerCase() === lower,
  );
};

/** Next fractional index above every existing shape on the canvas. */
export const nextIndex = (store: SerializedStore): string => {
  let max: string | undefined;
  for (const record of Object.values(store)) {
    if (record.typeName !== "shape") continue;
    const index = record.index;
    if (typeof index === "string" && (max === undefined || index > max)) {
      max = index;
    }
  }
  return getIndexAbove(max as never) as string;
};

const baseShape = ({
  id,
  type,
  parentId,
  index,
  x,
  y,
}: {
  id: string;
  type: string;
  parentId: string;
  index: string;
  x: number;
  y: number;
}) => ({
  id,
  typeName: "shape",
  type,
  parentId,
  index,
  x,
  y,
  rotation: 0,
  isLocked: false,
  opacity: 1,
  meta: {},
});

export const DISCOURSE_NODE_SHAPE_TYPE = "discourse-node";

/**
 * Node type id of a node shape under either convention: modern shapes carry it
 * in props.nodeTypeId, legacy shapes as shape.type. Mirrors the client's
 * getDiscourseNodeTypeId (DiscourseNodeUtil.tsx).
 */
export const shapeNodeTypeId = (shape: TldrawRecord): string => {
  const props = shape.props as { nodeTypeId?: string } | undefined;
  return props?.nodeTypeId || String(shape.type ?? "");
};

// Headless approximation of the client's card measurement
// (calcCanvasNodeSizeAndImg → measureCanvasNodeText: a DOM div at Inter 16px,
// line-height 1.35, 40px padding on every side, width fit-content capped at
// 400px). 7.7px average glyph width for Inter 16px; ragged word wrapping
// leaves ~7% of each line unused.
const NODE_MAX_WIDTH = 400;
const NODE_PADDING = 40;
const NODE_LINE_HEIGHT = 16 * 1.35;
const AVG_GLYPH_WIDTH = 7.7;
const LINE_FILL = 0.93;

/** Size a node card the way the app would; the app recomputes nothing on load. */
export const estimateNodeSize = (title: string): { w: number; h: number } => {
  const textWidth = Math.ceil(title.length * AVG_GLYPH_WIDTH);
  const lineWidth = (NODE_MAX_WIDTH - 2 * NODE_PADDING) * LINE_FILL;
  const lines = Math.max(1, Math.ceil(textWidth / lineWidth));
  const w = lines > 1 ? NODE_MAX_WIDTH : Math.max(160, textWidth + 2 * NODE_PADDING);
  const h = Math.round(2 * NODE_PADDING + lines * NODE_LINE_HEIGHT);
  return { w, h };
};

export const createNodeShapeRecord = ({
  nodeType,
  uid,
  title,
  x,
  y,
  parentId,
  index,
}: {
  nodeType: CanvasNodeType;
  uid: string;
  title: string;
  x: number;
  y: number;
  parentId: string;
  index: string;
}): TldrawRecord => {
  const { w, h } = estimateNodeSize(title);
  return {
    ...baseShape({
      id: newShapeId(),
      type: DISCOURSE_NODE_SHAPE_TYPE,
      parentId,
      index,
      x,
      y,
    }),
    props: {
      w,
      h,
      uid,
      title,
      nodeTypeId: nodeType.id,
      size: "s",
      fontFamily: "sans",
      imageUrl: "",
    },
  };
};

const RELATION_COLOR_BY_LABEL: Record<string, string> = {
  supports: "green",
  opposes: "red",
  informs: "grey",
};

export const createRelationRecords = ({
  relation,
  fromShape,
  toShape,
  parentId,
  index,
}: {
  relation: CanvasRelationType;
  fromShape: TldrawRecord;
  toShape: TldrawRecord;
  parentId: string;
  index: string;
}): TldrawRecord[] => {
  const color = RELATION_COLOR_BY_LABEL[relation.label.toLowerCase()] ?? "black";
  const center = (s: TldrawRecord) => {
    const props = (s.props ?? {}) as { w?: number; h?: number };
    return {
      x: (s.x as number) + (props.w ?? 0) / 2,
      y: (s.y as number) + (props.h ?? 0) / 2,
    };
  };
  const from = center(fromShape);
  const to = center(toShape);
  const arrowId = newShapeId();

  // Exactly the deployed arrowShapeProps key set — do not add keys (strict validators).
  const arrow: TldrawRecord = {
    ...baseShape({
      id: arrowId,
      type: relation.id,
      parentId,
      index,
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
    }),
    props: {
      dash: "draw",
      size: "m",
      fill: "none",
      color,
      labelColor: "black",
      bend: 0,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      text: relation.label,
      labelPosition: 0.5,
      font: "draw",
      scale: 1,
    },
  };
  const makeBinding = (terminal: "start" | "end", toId: string): TldrawRecord => ({
    id: newBindingId(),
    typeName: "binding",
    type: relation.id,
    fromId: arrowId,
    toId,
    props: {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
    },
    meta: {},
  });
  return [arrow, makeBinding("start", fromShape.id), makeBinding("end", toShape.id)];
};

// tldraw lays autoSize text out on ONE line, ignoring the stored width, so a
// long label becomes a horizontal streak across the canvas. Labels that would
// exceed this width wrap instead (autoSize false + a real width). ~12px is an
// eyeballed average glyph width for the "draw" font at size "m" (25px).
const TEXT_WRAP_WIDTH = 400;
const TEXT_GLYPH_WIDTH = 12;

export const createTextShapeRecord = ({
  text,
  x,
  y,
  parentId,
  index,
  width,
}: {
  text: string;
  x: number;
  y: number;
  parentId: string;
  index: string;
  /** Wrap the text at this width. Default: single line up to 400px, then wrap at 400. */
  width?: number;
}): TldrawRecord => {
  const naturalWidth = Math.max(8, Math.ceil(text.length * TEXT_GLYPH_WIDTH));
  const wrapWidth = width ?? (naturalWidth > TEXT_WRAP_WIDTH ? TEXT_WRAP_WIDTH : undefined);
  return {
    ...baseShape({ id: newShapeId(), type: "text", parentId, index, x, y }),
    props: {
      color: "black",
      size: "m",
      font: "draw",
      textAlign: "start",
      autoSize: wrapWidth === undefined,
      w: wrapWidth ?? naturalWidth,
      text,
      scale: 1,
    },
  };
};

export const createFrameShapeRecord = ({
  name,
  x,
  y,
  w,
  h,
  parentId,
  index,
}: {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId: string;
  index: string;
}): TldrawRecord => ({
  ...baseShape({ id: newShapeId(), type: "frame", parentId, index, x, y }),
  props: { w, h, name },
});

const asPoint = (v: unknown): { x: number; y: number } => {
  const p = (v ?? {}) as { x?: number; y?: number };
  return { x: typeof p.x === "number" ? p.x : 0, y: typeof p.y === "number" ? p.y : 0 };
};

/**
 * Re-aim an arrow shape's endpoints to absolute canvas points, keeping every
 * other prop (bend, arrowheads, label). An arrow stores its start/end relative
 * to shape.x/y, so this rewrites origin + both vectors together. A terminal
 * that a binding controls follows its bound shape, not props, so re-pointing
 * it is refused.
 */
export const repointArrow = (
  store: SerializedStore,
  shapeId: string,
  target: { start?: { x: number; y: number }; end?: { x: number; y: number } },
): void => {
  const shape = store[shapeId];
  if (!shape || shape.typeName !== "shape") throw new Error(`Shape not found: ${shapeId}`);
  const props = shape.props as { start?: unknown; end?: unknown } | undefined;
  if (!props || !("start" in props) || !("end" in props)) {
    throw new Error(`${shapeId} is not an arrow shape (no start/end props); pass x/y to move it.`);
  }
  for (const r of Object.values(store)) {
    if (r.typeName !== "binding" || r.fromId !== shapeId) continue;
    const terminal = (r.props as { terminal?: string } | undefined)?.terminal;
    if ((terminal === "start" && target.start) || (terminal === "end" && target.end)) {
      throw new Error(
        `The ${terminal} of ${shapeId} is bound to shape ${String(r.toId)} and follows it. Delete the arrow and reconnect instead of re-pointing.`,
      );
    }
  }
  const parentId = typeof shape.parentId === "string" ? shape.parentId : "";
  const parentOrigin = parentId.startsWith("shape:")
    ? shapeAbsoluteOrigin(store, parentId)
    : { x: 0, y: 0 };
  const originX = parentOrigin.x + (typeof shape.x === "number" ? shape.x : 0);
  const originY = parentOrigin.y + (typeof shape.y === "number" ? shape.y : 0);
  const cur = { start: asPoint(props.start), end: asPoint(props.end) };
  const a = target.start ?? { x: originX + cur.start.x, y: originY + cur.start.y };
  const b = target.end ?? { x: originX + cur.end.x, y: originY + cur.end.y };
  shape.x = a.x - parentOrigin.x;
  shape.y = a.y - parentOrigin.y;
  (shape.props as { start: unknown; end: unknown }).start = { x: 0, y: 0 };
  (shape.props as { start: unknown; end: unknown }).end = { x: b.x - a.x, y: b.y - a.y };
};

/**
 * Expand a set of shape ids to delete with dependent records: bindings attached
 * to them, and relation arrows left dangling (plus those arrows' other bindings).
 */
export const expandDeletionSet = (
  store: SerializedStore,
  shapeIds: string[],
): Set<string> => {
  const toDelete = new Set(shapeIds);
  const bindings = Object.values(store).filter((r) => r.typeName === "binding");
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of bindings) {
      if (toDelete.has(b.id)) continue;
      const from = b.fromId as string;
      const to = b.toId as string;
      if (toDelete.has(from) || toDelete.has(to)) {
        toDelete.add(b.id);
        if (toDelete.has(to) && !toDelete.has(from)) toDelete.add(from);
        changed = true;
      }
    }
  }
  return toDelete;
};
