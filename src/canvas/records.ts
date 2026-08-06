// Author tldraw 2.4.6 records matching the DEPLOYED extension's conventions.
// Node shapes use the legacy convention (shape.type = node type id) because the
// deployed client has no util registered for the newer "discourse-node" type.
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

/** Rough size heuristic; the app recomputes nothing on load, so keep it sane. */
export const estimateNodeSize = (title: string): { w: number; h: number } => {
  const len = title.length;
  const w = Math.max(200, Math.min(380, 40 + 9 * Math.min(len, 40)));
  const lines = Math.max(1, Math.ceil(len / 34));
  const h = Math.min(220, 60 + 20 * (lines - 1));
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
    ...baseShape({ id: newShapeId(), type: nodeType.id, parentId, index, x, y }),
    props: { w, h, uid, title, size: "s", fontFamily: "sans", imageUrl: "" },
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
