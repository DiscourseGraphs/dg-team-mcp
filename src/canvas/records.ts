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

export const getPageRecordId = (store: SerializedStore): string => {
  const page = Object.values(store).find((r) => r.typeName === "page");
  return page?.id ?? "page:page";
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

export const createTextShapeRecord = ({
  text,
  x,
  y,
  parentId,
  index,
}: {
  text: string;
  x: number;
  y: number;
  parentId: string;
  index: string;
}): TldrawRecord => ({
  ...baseShape({ id: newShapeId(), type: "text", parentId, index, x, y }),
  props: {
    color: "black",
    size: "m",
    font: "draw",
    textAlign: "start",
    autoSize: true,
    w: 8,
    text,
    scale: 1,
  },
});

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
