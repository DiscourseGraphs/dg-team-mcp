// Canvas tools: agentic read/write of discourse-graph canvases (tldraw boards
// persisted in Roam page props) via the Local API. Multiple tools per file,
// following the proposed-writes.ts precedent. Registered under the
// DG_MCP_CANVAS_TOOLS group in ../index.ts.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-local";
import { datalogQuery } from "../roam.js";
import {
  getCanvasContext,
  resolveNodeType,
  resolveRelation,
  formatNodeTitle,
} from "../canvas/context.js";
import { readCanvasState, summarizeCanvas } from "../canvas/snapshot.js";
import { mutateCanvas, createCanvasPage } from "../canvas/write.js";
import {
  createNodeShapeRecord,
  createRelationRecords,
  createTextShapeRecord,
  createFrameShapeRecord,
  expandDeletionSet,
  generateRoamUid,
  nextIndex,
  resolveFrame,
  shapeAbsoluteOrigin,
  shapeNodeTypeId,
} from "../canvas/records.js";
import { resolvePage } from "../canvas/props.js";
import type { CanvasContext, TldrawRecord } from "../canvas/model.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const graphField = z
  .string()
  .optional()
  .describe("Graph name or nickname. Auto-selects if only one graph is configured.");
const canvasField = z
  .string()
  .describe("Canvas page title (e.g. 'Canvas/My Map') or its 9-char page uid");

// Config discovery does several datalog calls + a search; cache briefly per graph.
const ctxCache = new Map<string, { ctx: CanvasContext; at: number }>();
const CTX_TTL_MS = 60_000;
const getCtx = async (client: RoamClient, nickname: string): Promise<CanvasContext> => {
  const cached = ctxCache.get(nickname);
  if (cached && Date.now() - cached.at < CTX_TTL_MS) return cached.ctx;
  const ctx = await getCanvasContext(client);
  ctxCache.set(nickname, { ctx, at: Date.now() });
  return ctx;
};

const canvasRef = (canvas: string): { title?: string; uid?: string } =>
  /^[\w-]{9}$/.test(canvas) && !canvas.includes("/") ? { uid: canvas } : { title: canvas };

const findNodeShape = (
  store: Record<string, TldrawRecord>,
  ref: string,
): TldrawRecord | undefined => {
  if (store[ref]?.typeName === "shape") return store[ref];
  const byShapeId = store[`shape:${ref}`];
  if (byShapeId?.typeName === "shape") return byShapeId;
  return Object.values(store).find(
    (r) => r.typeName === "shape" && (r.props as { uid?: string } | undefined)?.uid === ref,
  );
};

// ── canvas_list ─────────────────────────────────────────────────────────────
export const CanvasListSchema = z.object({ graph: graphField });
export const canvasListDescription =
  "List discourse-graph canvas pages in a Roam graph (pages whose title matches the graph's canvas page format, default Canvas/*).";
export const handleCanvasList = async (
  client: RoamClient,
  nickname: string,
): Promise<ToolResult> => {
  const ctx = await getCtx(client, nickname);
  const format = ctx.canvasPageFormat;
  const starIdx = format.indexOf("*");
  const prefix = starIdx === -1 ? format : format.slice(0, starIdx);
  const regex = new RegExp(
    `^${format.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".+" : `\\${c}`))}$`,
  );
  const rows = await datalogQuery<[string, string]>(
    client,
    `[:find ?title ?uid :where [?e :node/title ?title] [?e :block/uid ?uid] [(clojure.string/starts-with? ?title "${prefix}")]]`,
  );
  const canvases = rows
    .filter(([title]) => regex.test(title))
    .map(([title, uid]) => ({ title, uid }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return ok({ canvasPageFormat: format, count: canvases.length, canvases });
};

// ── canvas_types ────────────────────────────────────────────────────────────
export const CanvasTypesSchema = z.object({ graph: graphField });
export const canvasTypesDescription =
  "List the discourse node types (id, name, format, shortcut, color) and relation types (id, label, source→destination) available for canvas authoring in a graph. Ids are needed by canvas_add_node / canvas_connect.";
export const handleCanvasTypes = async (
  client: RoamClient,
  nickname: string,
): Promise<ToolResult> => {
  const ctx = await getCtx(client, nickname);
  return ok({
    nodeTypes: Object.values(ctx.nodes),
    relationTypes: Object.values(ctx.relations).map((r) => ({
      ...r,
      sourceText: r.source ? ctx.nodes[r.source]?.text : undefined,
      destinationText: r.destination ? ctx.nodes[r.destination]?.text : undefined,
    })),
    canvasPageFormat: ctx.canvasPageFormat,
  });
};

// ── canvas_read ─────────────────────────────────────────────────────────────
export const CanvasReadSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  include_raw: z
    .array(z.string())
    .optional()
    .describe("Shape ids to also return as raw tldraw records"),
});
export const canvasReadDescription =
  "Read a canvas: discourse nodes (Roam page uid, title, type, absolute position, containing frame), typed relations between them, text shapes, frames, and images (with filename + URL). Optionally include raw tldraw records for specific shape ids.";
export const handleCanvasRead = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasReadSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const state = await readCanvasState(client, canvasRef(p.canvas));
  const summary = summarizeCanvas(state, ctx);
  const raw =
    p.include_raw?.length && state.store
      ? Object.fromEntries(
          p.include_raw
            .map((id) => [id, state.store[id]] as const)
            .filter(([, r]) => r !== undefined),
        )
      : undefined;
  return ok(raw ? { ...summary, raw } : summary);
};

// ── canvas_create ───────────────────────────────────────────────────────────
export const CanvasCreateSchema = z.object({
  graph: graphField,
  name: z.string().describe("Canvas name (fills the * in the graph's canvas page format)"),
});
export const canvasCreateDescription =
  "Create a new empty canvas page. `name` fills the * in the graph's canvas page format (default Canvas/*), e.g. name 'My Map' → page 'Canvas/My Map'.";
export const handleCanvasCreate = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasCreateSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  return ok(await createCanvasPage(client, ctx, p.name));
};

// ── canvas_add_node ─────────────────────────────────────────────────────────
export const CanvasAddNodeSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  node_type: z
    .string()
    .optional()
    .describe("Node type id, name, format tag (e.g. EVD), or shortcut — see canvas_types"),
  text: z
    .string()
    .optional()
    .describe("Node content — substituted into the type's {content} format slot"),
  existing_page: z
    .string()
    .optional()
    .describe("Title or uid of an existing Roam page to place on the canvas"),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const canvasAddNodeDescription =
  "Add a discourse node to a canvas. Either reference an existing Roam page (existing_page = title or uid) or provide node_type + text to create the node page (title formatted per the type's format string; v1 does not fill {Source}-style referenced tokens or insert templates). Returns the new shape id and node page uid.";
export const handleCanvasAddNode = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddNodeSchema.parse(args);
  const ctx = await getCtx(client, nickname);

  let pageUid: string;
  let title: string;
  let createdPage = false;
  let nodeType = p.node_type ? resolveNodeType(ctx, p.node_type) : undefined;
  if (p.node_type && !nodeType) {
    throw new Error(
      `Unknown node type "${p.node_type}". Available: ${Object.values(ctx.nodes)
        .map((n) => `${n.text} (${n.id})`)
        .join(", ")}`,
    );
  }

  if (p.existing_page) {
    const resolved =
      (await resolvePage(client, { title: p.existing_page })) ??
      (await resolvePage(client, { uid: p.existing_page }));
    if (!resolved) throw new Error(`Page not found: "${p.existing_page}"`);
    pageUid = resolved.uid;
    title = resolved.title;
    if (!nodeType) {
      nodeType = Object.values(ctx.nodes).find((n) => {
        const prefix = n.format.split(/{content}/i)[0]?.trim();
        return prefix && title.startsWith(prefix);
      });
      if (!nodeType)
        throw new Error(
          `Could not infer node type from title "${title}"; pass node_type explicitly.`,
        );
    }
  } else {
    if (!nodeType || !p.text) throw new Error("Provide node_type + text, or existing_page.");
    title = formatNodeTitle(nodeType, p.text);
    const existing = await resolvePage(client, { title });
    if (existing) {
      pageUid = existing.uid;
    } else {
      pageUid = generateRoamUid();
      await client.call("data.page.fromMarkdown", [
        { page: { title, uid: pageUid }, "markdown-string": "" },
      ]);
      createdPage = true;
    }
  }

  const finalNodeType = nodeType;
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const existingShape = Object.values(store).find(
      (r) => r.typeName === "shape" && (r.props as { uid?: string } | undefined)?.uid === pageUid,
    );
    if (existingShape) {
      throw new Error(`"${title}" is already on this canvas (shape ${existingShape.id}).`);
    }
    let maxY = 0;
    for (const r of Object.values(store)) {
      if (r.typeName === "shape" && typeof r.y === "number")
        maxY = Math.max(maxY, r.y + ((r.props as { h?: number })?.h ?? 0));
    }
    const shape = createNodeShapeRecord({
      nodeType: finalNodeType,
      uid: pageUid,
      title,
      x: p.x ?? 100,
      y: p.y ?? (maxY ? maxY + 60 : 100),
      parentId: helpers.pageRecordId,
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });

  return ok({
    ...result,
    nodePageUid: pageUid,
    title,
    nodeTypeId: finalNodeType.id,
    createdPage,
  });
};

// ── canvas_connect ──────────────────────────────────────────────────────────
export const CanvasConnectSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  relation: z.string().describe("Relation id or label (see canvas_types)"),
  from: z.string().describe("Source: shape id or node page uid"),
  to: z.string().describe("Destination: shape id or node page uid"),
});
export const canvasConnectDescription =
  "Connect two discourse nodes on a canvas with a typed relation arrow (e.g. Supports, Opposes, Informs). from/to accept a shape id or the node's Roam page uid. Direction: from = relation source, to = destination.";
export const handleCanvasConnect = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasConnectSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const fromShape = findNodeShape(store, p.from);
    const toShape = findNodeShape(store, p.to);
    if (!fromShape) throw new Error(`No shape found on canvas for "${p.from}"`);
    if (!toShape) throw new Error(`No shape found on canvas for "${p.to}"`);
    const { relation, ambiguous } = resolveRelation(ctx, p.relation, {
      sourceTypeId: shapeNodeTypeId(fromShape),
      destinationTypeId: shapeNodeTypeId(toShape),
    });
    if (!relation) {
      if (ambiguous?.length) {
        throw new Error(
          `Relation "${p.relation}" is ambiguous for these node types; use an id: ${ambiguous
            .map(
              (r) =>
                `${r.id} (${ctx.nodes[r.source ?? ""]?.text ?? r.source} → ${ctx.nodes[r.destination ?? ""]?.text ?? r.destination})`,
            )
            .join(", ")}`,
        );
      }
      throw new Error(
        `Unknown relation "${p.relation}". Available: ${Object.values(ctx.relations)
          .map((r) => `${r.label} (${r.id})`)
          .join(", ")}`,
      );
    }
    const records = createRelationRecords({
      relation,
      fromShape,
      toShape,
      parentId: helpers.pageRecordId,
      index: nextIndex(store),
    });
    for (const r of records) store[r.id] = r;
    return { arrowShapeId: records[0]!.id, relationId: relation.id, label: relation.label };
  });
  return ok(result);
};

// ── canvas_add_text ─────────────────────────────────────────────────────────
export const CanvasAddTextSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  text: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const canvasAddTextDescription = "Add a free-floating text label to a canvas.";
export const handleCanvasAddText = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddTextSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const shape = createTextShapeRecord({
      text: p.text,
      x: p.x ?? 100,
      y: p.y ?? 100,
      parentId: helpers.pageRecordId,
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });
  return ok(result);
};

// ── canvas_create_frame ─────────────────────────────────────────────────────
export const CanvasCreateFrameSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  name: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});
export const canvasCreateFrameDescription = "Add a named frame (group region) to a canvas.";
export const handleCanvasCreateFrame = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasCreateFrameSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const shape = createFrameShapeRecord({
      name: p.name,
      x: p.x ?? 0,
      y: p.y ?? 0,
      w: p.w ?? 800,
      h: p.h ?? 600,
      parentId: helpers.pageRecordId,
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });
  return ok(result);
};

// ── canvas_move ─────────────────────────────────────────────────────────────
export const CanvasMoveSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  moves: z
    .array(z.object({ shape_id: z.string(), x: z.number(), y: z.number() }))
    .min(1),
  into_frame: z
    .string()
    .optional()
    .describe("Frame shape id or name to move the shapes into, or 'page' to un-frame them"),
});
export const canvasMoveDescription =
  "Move shapes to new positions. x/y are ALWAYS absolute canvas coordinates (converted to frame-local storage automatically). Pass into_frame (a frame's shape id or name) to move the shapes into that frame; pass into_frame:'page' to pop them out to the top level. Omit into_frame to reposition within the current parent.";
export const handleCanvasMove = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasMoveSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    let targetParentId: string | undefined;
    let frameName: string | undefined;
    if (p.into_frame && p.into_frame.toLowerCase() !== "page") {
      const frame = resolveFrame(store, p.into_frame);
      if (!frame) throw new Error(`No frame named or with id "${p.into_frame}" on this canvas.`);
      targetParentId = frame.id;
      frameName = String((frame.props as { name?: string }).name ?? frame.id);
    } else if (p.into_frame) {
      targetParentId = helpers.pageRecordId;
    }
    for (const move of p.moves) {
      const shape = store[move.shape_id];
      if (!shape || shape.typeName !== "shape")
        throw new Error(`Shape not found: ${move.shape_id}`);
      const parentId = targetParentId ?? (shape.parentId as string) ?? helpers.pageRecordId;
      const origin = parentId.startsWith("shape:")
        ? shapeAbsoluteOrigin(store, parentId)
        : { x: 0, y: 0 };
      shape.parentId = parentId;
      shape.x = move.x - origin.x;
      shape.y = move.y - origin.y;
      if (targetParentId) shape.index = nextIndex(store);
    }
    return {
      moved: p.moves.length,
      ...(p.into_frame ? { intoFrame: frameName ?? "page" } : {}),
    };
  });
  return ok(result);
};

// ── canvas_delete ───────────────────────────────────────────────────────────
export const CanvasDeleteSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  shape_ids: z.array(z.string()).min(1),
});
export const canvasDeleteDescription =
  "Delete shapes from a canvas by shape id. Attached relation arrows and bindings are cleaned up automatically. Does NOT delete the underlying Roam pages.";
export const handleCanvasDelete = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasDeleteSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store) => {
    for (const id of p.shape_ids) {
      if (!store[id]) throw new Error(`Shape not found: ${id}`);
    }
    const toDelete = expandDeletionSet(store, p.shape_ids);
    for (const id of toDelete) delete store[id];
    return { deleted: [...toDelete] };
  });
  return ok(result);
};
