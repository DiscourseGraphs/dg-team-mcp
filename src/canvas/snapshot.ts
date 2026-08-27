// Read a canvas page's persisted tldraw state and summarize it for agents.

import type { RoamClient } from "@roam-research/roam-tools-local";
import type {
  CanvasContext,
  CanvasPageState,
  CanvasSummary,
  Json,
  JsonObject,
  SerializedSchema,
  SerializedStore,
  TldrawRecord,
} from "./model.js";
import { getPageProps, resolvePage } from "./props.js";
import { shapeAbsoluteOrigin } from "./records.js";
import { findUnloadableRecords } from "./schema.js";

const RJSQB_KEY = "roamjs-query-builder";

const asObject = (v: Json | undefined): JsonObject =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
const num = (v: Json | undefined): number => (typeof v === "number" ? v : 0);
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

export const readCanvasState = async (
  client: RoamClient,
  ref: { title?: string; uid?: string },
): Promise<CanvasPageState> => {
  const page = await resolvePage(client, ref);
  if (!page) {
    throw new Error(
      `Page not found: ${ref.title ?? ref.uid}. Use canvas_list to see available canvases.`,
    );
  }
  const allProps = await getPageProps(client, page.uid);
  const rjsqb = asObject(allProps[RJSQB_KEY]);
  const tldraw = rjsqb.tldraw;
  const rjsqbSiblings: JsonObject = Object.fromEntries(
    Object.entries(rjsqb).filter(([k]) => k !== "tldraw" && k !== "stateId"),
  );
  const base = {
    pageUid: page.uid,
    title: page.title,
    allProps,
    rjsqbSiblings,
    stateId: typeof rjsqb.stateId === "string" ? rjsqb.stateId : null,
  };

  if (!tldraw || typeof tldraw !== "object" || Array.isArray(tldraw)) {
    return { ...base, format: "none", store: {}, schema: null };
  }
  const tldrawObj = tldraw as JsonObject;
  if ("store" in tldrawObj && "schema" in tldrawObj) {
    return {
      ...base,
      format: "snapshot",
      store: asObject(tldrawObj.store) as SerializedStore,
      schema: asObject(tldrawObj.schema) as unknown as SerializedSchema,
    };
  }
  // Bare legacy serialized store (pre-{store,schema}); read-only in v1.
  return { ...base, format: "legacy-raw", store: tldrawObj as SerializedStore, schema: null };
};

export const summarizeCanvas = (
  state: CanvasPageState,
  ctx: CanvasContext,
): CanvasSummary => {
  const records = Object.values(state.store) as TldrawRecord[];
  const shapes = records.filter((r) => r.typeName === "shape");
  const bindings = records.filter((r) => r.typeName === "binding");
  const assets = records.filter((r) => r.typeName === "asset");
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const summary: CanvasSummary = {
    pageUid: state.pageUid,
    title: state.title,
    format: state.format,
    nodes: [],
    relations: [],
    texts: [],
    frames: [],
    images: [],
    otherShapes: [],
  };

  const nodeShapeIds = new Set<string>();
  const uidByShapeId = new Map<string, string>();

  const frameName = new Map<string, string>();
  for (const shape of shapes) {
    if (str(shape.type) === "frame") frameName.set(shape.id, str(asObject(shape.props).name));
  }
  const parentFrame = (shape: TldrawRecord): string | undefined =>
    frameName.get(str(shape.parentId));
  const absolute = (shape: TldrawRecord) => shapeAbsoluteOrigin(state.store, shape.id);

  for (const shape of shapes) {
    const type = str(shape.type);
    const props = asObject(shape.props);
    const isModernNode = type === "discourse-node";
    const isLegacyNode =
      !isModernNode && typeof props.uid === "string" && typeof props.title === "string";
    if (isModernNode || (isLegacyNode && !ctx.relations[type])) {
      const nodeTypeId = isModernNode ? str(props.nodeTypeId) : type;
      const pos = absolute(shape);
      summary.nodes.push({
        shapeId: shape.id,
        nodeTypeId,
        nodeTypeText: ctx.nodes[nodeTypeId]?.text,
        uid: str(props.uid),
        title: str(props.title),
        x: pos.x,
        y: pos.y,
        w: num(props.w),
        h: num(props.h),
        frame: parentFrame(shape),
      });
      nodeShapeIds.add(shape.id);
      uidByShapeId.set(shape.id, str(props.uid));
    }
  }

  for (const shape of shapes) {
    if (nodeShapeIds.has(shape.id)) continue;
    const type = str(shape.type);
    const props = asObject(shape.props);
    const looksLikeRelation =
      !!ctx.relations[type] ||
      type === "discourse-relation" ||
      ("arrowheadEnd" in props && !["arrow", "line"].includes(type));

    if (looksLikeRelation) {
      const rel = {
        shapeId: shape.id,
        relationId: type,
        label: ctx.relations[type]?.label ?? str(props.text) ?? type,
        fromShapeId: undefined as string | undefined,
        toShapeId: undefined as string | undefined,
        fromUid: undefined as string | undefined,
        toUid: undefined as string | undefined,
      };
      for (const b of bindings) {
        if (b.fromId !== shape.id) continue;
        const bp = asObject(b.props);
        if (bp.terminal === "start") rel.fromShapeId = str(b.toId);
        if (bp.terminal === "end") rel.toShapeId = str(b.toId);
      }
      const inlineStart = asObject(props.start);
      const inlineEnd = asObject(props.end);
      if (!rel.fromShapeId && typeof inlineStart.boundShapeId === "string")
        rel.fromShapeId = inlineStart.boundShapeId;
      if (!rel.toShapeId && typeof inlineEnd.boundShapeId === "string")
        rel.toShapeId = inlineEnd.boundShapeId;
      rel.fromUid = rel.fromShapeId ? uidByShapeId.get(rel.fromShapeId) : undefined;
      rel.toUid = rel.toShapeId ? uidByShapeId.get(rel.toShapeId) : undefined;
      summary.relations.push(rel);
      continue;
    }

    if (type === "text") {
      const pos = absolute(shape);
      summary.texts.push({
        shapeId: shape.id,
        text: str(props.text),
        x: pos.x,
        y: pos.y,
        frame: parentFrame(shape),
      });
    } else if (type === "frame") {
      const pos = absolute(shape);
      summary.frames.push({
        shapeId: shape.id,
        name: str(props.name),
        x: pos.x,
        y: pos.y,
        w: num(props.w),
        h: num(props.h),
      });
    } else if (type === "image") {
      const pos = absolute(shape);
      const asset = assetById.get(str(props.assetId));
      const assetProps = asObject(asset?.props);
      summary.images.push({
        shapeId: shape.id,
        name: str(assetProps.name),
        src: str(assetProps.src),
        x: pos.x,
        y: pos.y,
        w: num(props.w),
        h: num(props.h),
        frame: parentFrame(shape),
      });
    } else {
      summary.otherShapes.push({ shapeId: shape.id, type, frame: parentFrame(shape) });
    }
  }

  const byPosition = <T extends { y: number; x: number }>(a: T, b: T) =>
    a.y - b.y || a.x - b.x;
  summary.nodes.sort(byPosition);
  summary.texts.sort(byPosition);
  summary.frames.sort(byPosition);
  summary.images.sort(byPosition);

  // Read-back is only verification if it flags what the app would reject.
  if (state.format === "snapshot") {
    const issues = findUnloadableRecords(state.store, state.schema, ctx);
    if (issues.length) summary.warnings = issues;
  }
  return summary;
};
