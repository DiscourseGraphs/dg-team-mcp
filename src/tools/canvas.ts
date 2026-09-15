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
  createArrowShapeRecord,
  createBlockShapeRecord,
  createGeoShapeRecord,
  createImageRecords,
  createNodeShapeRecord,
  createRelationRecords,
  createTextShapeRecord,
  createFrameShapeRecord,
  expandDeletionSet,
  generateRoamUid,
  nextIndex,
  repointArrow,
  resolveFrame,
  shapeAbsoluteOrigin,
  shapeNodeTypeId,
} from "../canvas/records.js";
import {
  DEFAULT_PORTAL_ACCENT,
  DEFAULT_PORTAL_HEIGHT,
  DEFAULT_PORTAL_WIDTH,
  assertPageCapacity,
  createPageRecord,
  dedupePageName,
  deletePage,
  getNestedPageMeta,
  getSubpageMeta,
  moveShapesToPage,
  newPageId,
  portalLabel,
  syncPortalLabels,
} from "../canvas/nesting.js";
import { resolveBlock, resolvePage } from "../canvas/props.js";
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
const pageField = z
  .string()
  .optional()
  .describe(
    "Tldraw page to target (name or page record id), for canvases with several pages — see canvas_read `pages`. Omit on single-page canvases.",
  );

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
  "Read a canvas: discourse nodes (Roam page uid, title, type, absolute position, containing frame), Roam blocks placed on the board, typed relations between them, text shapes, frames, images (with filename + URL), plain geo shapes and arrows, and nested sub-canvas portals (`subpages`: which page each portal opens into). Lists the board's tldraw pages with their nesting parent (`parentPageId`); on multi-page boards every item names its page. Returns `warnings` for records the Roam app would refuse to load. Optionally include raw tldraw records for specific shape ids.";
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
  page: pageField,
});
export const canvasAddNodeDescription =
  "Add a discourse node to a canvas. Either reference an existing Roam page (existing_page = title or uid) or provide node_type + text to create the node page (title formatted per the type's format string; v1 does not fill {Source}-style referenced tokens or insert templates). Pages that match no discourse node type get the generic Page shape. For Roam blocks use canvas_add_block. Returns the new shape id and node page uid.";
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
  if (nodeType?.id === "blck-node") {
    throw new Error(
      "The Block type places Roam blocks — use canvas_add_block with the block's uid.",
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
      // Not a discourse node: fall back to the generic Page shape.
      nodeType ??= ctx.nodes["page-node"];
      if (!nodeType)
        throw new Error(
          `Could not infer node type from title "${title}"; pass node_type explicitly.`,
        );
    }
  } else {
    if (nodeType?.id === "page-node") {
      throw new Error(
        "The Page type places existing pages: pass existing_page (canvas_add_node never creates plain pages).",
      );
    }
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
    const targetPage = helpers.resolveTargetPage(p.page);
    const existingShape = Object.values(store).find(
      (r) =>
        r.typeName === "shape" &&
        (r.props as { uid?: string } | undefined)?.uid === pageUid &&
        helpers.shapePageId(r.id) === targetPage,
    );
    if (existingShape) {
      throw new Error(`"${title}" is already on this page (shape ${existingShape.id}).`);
    }
    let maxY = 0;
    for (const r of Object.values(store)) {
      if (
        r.typeName === "shape" &&
        typeof r.y === "number" &&
        helpers.shapePageId(r.id) === targetPage
      )
        maxY = Math.max(maxY, r.y + ((r.props as { h?: number })?.h ?? 0));
    }
    const shape = createNodeShapeRecord({
      nodeType: finalNodeType,
      uid: pageUid,
      title,
      x: p.x ?? 100,
      y: p.y ?? (maxY ? maxY + 60 : 100),
      parentId: targetPage,
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

// ── canvas_add_block ────────────────────────────────────────────────────────
export const CanvasAddBlockSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  block: z.string().describe("Uid of an existing Roam block, or a ((uid)) block ref"),
  x: z.number().optional(),
  y: z.number().optional(),
  page: pageField,
});
export const canvasAddBlockDescription =
  "Place an existing Roam block on a canvas (the extension's Block shape). The block's current text becomes the shape label; live canvases render the block itself. Does not create blocks — create the block first, then pass its uid. For pages use canvas_add_node.";
export const handleCanvasAddBlock = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddBlockSchema.parse(args);
  const ctx = await getCtx(client, nickname);

  const resolved = await resolveBlock(client, p.block);
  if (!resolved) {
    throw new Error(
      `No block with uid "${p.block}". Pass the uid of an existing block (or a ((uid)) ref); this tool does not create blocks.`,
    );
  }
  if ("isPage" in resolved) {
    throw new Error(
      `"${resolved.uid}" is a page uid, not a block. Use canvas_add_node with existing_page to place pages.`,
    );
  }
  const { uid, text } = resolved;

  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const targetPage = helpers.resolveTargetPage(p.page);
    const existingShape = Object.values(store).find(
      (r) =>
        r.typeName === "shape" &&
        shapeNodeTypeId(r) === "blck-node" &&
        (r.props as { uid?: string } | undefined)?.uid === uid &&
        helpers.shapePageId(r.id) === targetPage,
    );
    if (existingShape) {
      throw new Error(`Block ((${uid})) is already on this page (shape ${existingShape.id}).`);
    }
    let maxY = 0;
    for (const r of Object.values(store)) {
      if (
        r.typeName === "shape" &&
        typeof r.y === "number" &&
        helpers.shapePageId(r.id) === targetPage
      )
        maxY = Math.max(maxY, r.y + ((r.props as { h?: number })?.h ?? 0));
    }
    const shape = createBlockShapeRecord({
      uid,
      text,
      x: p.x ?? 100,
      y: p.y ?? (maxY ? maxY + 60 : 100),
      parentId: targetPage,
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });

  return ok({ ...result, blockUid: uid, text });
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
    const fromPage = helpers.shapePageId(fromShape.id);
    const toPage = helpers.shapePageId(toShape.id);
    if (fromPage && toPage && fromPage !== toPage) {
      throw new Error(
        "Cannot connect shapes on different tldraw pages — arrows cannot span pages.",
      );
    }
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
      parentId: fromPage ?? helpers.pageRecordId,
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
  width: z
    .number()
    .positive()
    .optional()
    .describe("Wrap the text at this width in canvas units. Default: one line up to 400, then wrap at 400."),
  page: pageField,
});
export const canvasAddTextDescription =
  "Add a free-floating text label to a canvas. Long labels wrap at `width` (default 400) instead of running across the canvas on one line.";
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
      parentId: helpers.resolveTargetPage(p.page),
      index: nextIndex(store),
      width: p.width,
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
  page: pageField,
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
      parentId: helpers.resolveTargetPage(p.page),
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });
  return ok(result);
};

// ── canvas_page_create ──────────────────────────────────────────────────────
export const CanvasPageCreateSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  name: z.string().describe("Name for the new tldraw page"),
});
export const canvasPageCreateDescription =
  "Create a new tldraw page INSIDE an existing canvas. A canvas is one Roam page holding one board; nesting and multi-page organization happen by adding tldraw pages within it, never by creating another canvas page. Colliding names get a numeric suffix; the returned name is the one actually used. Fails loudly at the app's 40-page cap.";
export const handleCanvasPageCreate = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasPageCreateSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store) => {
    assertPageCapacity(store);
    const name = dedupePageName(store, p.name);
    const record = createPageRecord({ store, name });
    store[record.id] = record;
    return { pageId: record.id, name };
  });
  return ok(result);
};

// ── canvas_page_rename ──────────────────────────────────────────────────────
export const CanvasPageRenameSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  page: z.string().describe("Tldraw page to rename (name or page record id)"),
  name: z.string().describe("New name"),
});
export const canvasPageRenameDescription =
  "Rename a tldraw page of a canvas. Portals targeting the page get their visible \"⤵ name\" label and stored title re-synced in the same write.";
export const handleCanvasPageRename = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasPageRenameSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const pageId = helpers.resolveTargetPage(p.page);
    const name = dedupePageName(store, p.name, pageId);
    store[pageId]!.name = name;
    const portalLabelsUpdated = syncPortalLabels(store, pageId, name);
    return { pageId, name, portalLabelsUpdated };
  });
  return ok(result);
};

// ── canvas_page_delete ──────────────────────────────────────────────────────
export const CanvasPageDeleteSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  page: z.string().describe("Tldraw page to delete (name or page record id)"),
});
export const canvasPageDeleteDescription =
  "Delete a tldraw page of a canvas along with every shape on it. Portals elsewhere that pointed at it are NOT deleted (live clients show \"target page not found\"); their shape ids come back as orphanedPortals so you can re-link or delete them deliberately. Refuses to delete the last page.";
export const handleCanvasPageDelete = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasPageDeleteSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const pageId = helpers.resolveTargetPage(p.page);
    const { removed, orphanedPortals } = deletePage(store, pageId);
    return { pageId, removedShapes: removed.length, orphanedPortals };
  });
  return ok(result);
};

// ── canvas_add_subpage ──────────────────────────────────────────────────────
export const CanvasAddSubpageSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  target_page: z
    .string()
    .describe(
      "Tldraw page the portal opens into (name or page record id). A name that matches no existing page creates the page.",
    ),
  title: z
    .string()
    .optional()
    .describe("Portal title bar text; defaults to the target page's name"),
  accent: z.string().optional().describe(`Portal accent color (hex); default ${DEFAULT_PORTAL_ACCENT}`),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  page: pageField,
});
export const canvasAddSubpageDescription =
  "Add a nested sub-canvas portal: a rectangle that previews another tldraw page of the SAME canvas and opens it on click (in plugin builds with the feature; other builds show a labeled \"⤵ name\" rectangle on a board that still loads). Creates the target page when it does not exist yet. Portals persist as native geo shapes with meta.dgSubpage; the page hierarchy lives in page meta. Populate the target page afterwards with the add tools and their `page` parameter.";
export const handleCanvasAddSubpage = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddSubpageSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const parentPageId = helpers.resolveTargetPage(p.page);
    let targetPageId: string;
    let targetPageName: string;
    let createdPage = false;
    try {
      targetPageId = helpers.resolveTargetPage(p.target_page);
      targetPageName = String(store[targetPageId]!.name ?? "");
    } catch {
      assertPageCapacity(store);
      targetPageId = newPageId();
      targetPageName = dedupePageName(store, p.target_page);
      createdPage = true;
    }
    if (targetPageId === parentPageId) {
      throw new Error("A portal cannot target the page it lives on.");
    }
    const title = p.title ?? targetPageName;
    const portal = createGeoShapeRecord({
      geo: "rectangle",
      text: portalLabel(targetPageName),
      x: p.x ?? 100,
      y: p.y ?? 100,
      w: p.w ?? DEFAULT_PORTAL_WIDTH,
      h: p.h ?? DEFAULT_PORTAL_HEIGHT,
      color: "violet",
      fill: "semi",
      parentId: parentPageId,
      index: nextIndex(store),
      meta: {
        dgSubpage: { targetPageId, accent: p.accent ?? DEFAULT_PORTAL_ACCENT, title },
      },
    });
    if (createdPage) {
      const record = createPageRecord({
        store,
        name: targetPageName,
        id: targetPageId,
        meta: { dgNested: { parentPageId, ownerShapeId: portal.id } },
      });
      store[record.id] = record;
    } else if (!getNestedPageMeta(store[targetPageId]!)) {
      // First portal into an existing page claims the lineage pointer; an
      // existing pointer is left alone (first parent wins).
      store[targetPageId]!.meta = {
        ...(store[targetPageId]!.meta as object),
        dgNested: { parentPageId, ownerShapeId: portal.id },
      };
    }
    store[portal.id] = portal;
    return { shapeId: portal.id, targetPageId, targetPageName, createdPage };
  });
  return ok(result);
};

// ── canvas_link_subpage ─────────────────────────────────────────────────────
export const CanvasLinkSubpageSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  shape_id: z.string().describe("An existing geo shape to turn into (or re-point as) a portal"),
  target_page: z.string().describe("Tldraw page the portal should open into (name or page record id)"),
});
export const canvasLinkSubpageDescription =
  "Turn an existing geo rectangle into a nested sub-canvas portal, or re-point an existing portal at a different tldraw page. The target page must already exist (canvas_add_subpage creates pages). Rewrites the shape's \"⤵ name\" label and takes over the target page's lineage pointer.";
export const handleCanvasLinkSubpage = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasLinkSubpageSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const shape = store[p.shape_id];
    if (!shape || shape.typeName !== "shape") throw new Error(`Shape not found: ${p.shape_id}`);
    if (shape.type !== "geo") {
      throw new Error(
        `Only geo shapes can be portals; ${p.shape_id} is "${String(shape.type)}". Create one with canvas_add_geo or canvas_add_subpage.`,
      );
    }
    const targetPageId = helpers.resolveTargetPage(p.target_page);
    const parentPageId = helpers.shapePageId(shape.id) ?? helpers.pageRecordId;
    if (targetPageId === parentPageId) {
      throw new Error("A portal cannot target the page it lives on.");
    }
    const targetPageName = String(store[targetPageId]!.name ?? "");
    const existing = getSubpageMeta(shape);
    shape.meta = {
      ...(shape.meta as object),
      dgSubpage: {
        targetPageId,
        accent: existing?.accent ?? DEFAULT_PORTAL_ACCENT,
        title: targetPageName,
      },
    };
    (shape.props as { text?: string }).text = portalLabel(targetPageName);
    store[targetPageId]!.meta = {
      ...(store[targetPageId]!.meta as object),
      dgNested: { parentPageId, ownerShapeId: shape.id },
    };
    return { shapeId: shape.id, targetPageId, targetPageName };
  });
  return ok(result);
};

// ── canvas_add_geo ──────────────────────────────────────────────────────────
export const CanvasAddGeoSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  geo: z
    .string()
    .describe(
      "Geo style: rectangle, ellipse, triangle, diamond, pentagon, hexagon, octagon, star, rhombus, oval, trapezoid, arrow-right, arrow-left, arrow-up, arrow-down, x-box, check-box, cloud",
    ),
  text: z.string().optional().describe("Label centered in the shape"),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional().describe("Default 200"),
  h: z.number().optional().describe("Default 100"),
  color: z
    .string()
    .optional()
    .describe(
      "black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, or red (default black)",
    ),
  fill: z.string().optional().describe("none, semi, solid, or pattern (default none)"),
  page: pageField,
});
export const canvasAddGeoDescription =
  "Add a plain tldraw geo shape (rectangle, ellipse, …) with an optional centered label. This is the general-purpose labeled box; discourse nodes belong in canvas_add_node.";
export const handleCanvasAddGeo = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddGeoSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const shape = createGeoShapeRecord({
      geo: p.geo,
      text: p.text,
      x: p.x ?? 100,
      y: p.y ?? 100,
      w: p.w ?? 200,
      h: p.h ?? 100,
      color: p.color,
      fill: p.fill,
      parentId: helpers.resolveTargetPage(p.page),
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });
  return ok(result);
};

// ── canvas_add_arrow ────────────────────────────────────────────────────────
const arrowPointSchema = z.object({ x: z.number(), y: z.number() });
export const CanvasAddArrowSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  start: arrowPointSchema.describe("Absolute start point"),
  end: arrowPointSchema.describe("Absolute end point"),
  text: z.string().optional().describe("Label at the arrow midpoint"),
  bend: z.number().optional().describe("Curvature; 0 (default) is straight"),
  page: pageField,
});
export const canvasAddArrowDescription =
  "Add a plain (untyped) arrow between two absolute points, optionally labeled. For typed discourse relations between nodes use canvas_connect instead.";
export const handleCanvasAddArrow = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddArrowSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const shape = createArrowShapeRecord({
      start: p.start,
      end: p.end,
      text: p.text,
      bend: p.bend,
      parentId: helpers.resolveTargetPage(p.page),
      index: nextIndex(store),
    });
    store[shape.id] = shape;
    return { shapeId: shape.id };
  });
  return ok(result);
};

// ── canvas_add_image ────────────────────────────────────────────────────────
export const CanvasAddImageSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  src: z
    .string()
    .describe(
      "Image URL (https or data URI). For local files, upload to Roam first (e.g. the roam MCP's file_upload) and pass the resulting URL.",
    ),
  name: z.string().optional().describe("Filename shown in summaries"),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional().describe("Display width; pass the real pixel width when known (default 400)"),
  h: z.number().optional().describe("Display height (default 300)"),
  page: pageField,
});
export const canvasAddImageDescription =
  "Place an image on a canvas from a URL (creates the tldraw asset + image shape). Pass real dimensions when known; the canvas does not measure the file.";
export const handleCanvasAddImage = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasAddImageSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    const { asset, shape } = createImageRecords({
      src: p.src,
      name: p.name,
      x: p.x ?? 100,
      y: p.y ?? 100,
      w: p.w ?? 400,
      h: p.h ?? 300,
      parentId: helpers.resolveTargetPage(p.page),
      index: nextIndex(store),
    });
    store[asset.id] = asset;
    store[shape.id] = shape;
    return { shapeId: shape.id, assetId: asset.id };
  });
  return ok(result);
};

// ── canvas_move ─────────────────────────────────────────────────────────────
const pointSchema = z.object({ x: z.number(), y: z.number() });
export const CanvasMoveSchema = z.object({
  graph: graphField,
  canvas: canvasField,
  moves: z
    .array(
      z.object({
        shape_id: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        start: pointSchema
          .optional()
          .describe("Arrows only: new absolute start point (re-aims the arrow)"),
        end: pointSchema
          .optional()
          .describe("Arrows only: new absolute end point (re-aims the arrow)"),
      }),
    )
    .min(1),
  into_frame: z
    .string()
    .optional()
    .describe("Frame shape id or name to move the shapes into, or 'page' to un-frame them"),
  into_page: z
    .string()
    .optional()
    .describe(
      "Tldraw page (name or page record id) to move the shapes to. x/y become optional (shapes keep their coordinates). A bound arrow follows when both its endpoints move; a move that would split one across pages is refused.",
    ),
});
export const canvasMoveDescription =
  "Move shapes to new positions, re-aim arrows, or move shapes to another tldraw page. All coordinates are ALWAYS absolute canvas coordinates (converted to frame-local storage automatically). Pass x/y to move a shape. For an arrow, pass start and/or end points instead to re-aim it (bound terminals, e.g. from canvas_connect, follow their shape and cannot be re-aimed). Pass into_frame (a frame's shape id or name) to move the shapes into that frame; pass into_frame:'page' to pop them out to the top level. Pass into_page (a tldraw page name or id) to move shapes between the board's pages.";
export const handleCanvasMove = async (
  client: RoamClient,
  nickname: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const p = CanvasMoveSchema.parse(args);
  const ctx = await getCtx(client, nickname);
  const result = await mutateCanvas(client, canvasRef(p.canvas), ctx, (store, helpers) => {
    if (p.into_frame && p.into_page) {
      throw new Error("Pass either into_frame or into_page, not both.");
    }
    let targetFrameId: string | undefined;
    let unframe = false;
    let frameName: string | undefined;
    if (p.into_frame && p.into_frame.toLowerCase() !== "page") {
      const frame = resolveFrame(store, p.into_frame);
      if (!frame) throw new Error(`No frame named or with id "${p.into_frame}" on this canvas.`);
      targetFrameId = frame.id;
      frameName = String((frame.props as { name?: string }).name ?? frame.id);
    } else if (p.into_frame) {
      unframe = true;
    }
    let repointed = 0;
    for (const move of p.moves) {
      const shape = store[move.shape_id];
      if (!shape || shape.typeName !== "shape")
        throw new Error(`Shape not found: ${move.shape_id}`);
      if (move.start || move.end) {
        if (move.x !== undefined || move.y !== undefined) {
          throw new Error(
            `${move.shape_id}: pass either x/y or start/end, not both (start/end place the arrow).`,
          );
        }
        repointArrow(store, move.shape_id, { start: move.start, end: move.end });
        repointed += 1;
        continue;
      }
      if (move.x === undefined || move.y === undefined) {
        if (p.into_page) continue; // page move keeps coordinates
        throw new Error(`${move.shape_id}: pass x and y (or start/end for an arrow).`);
      }
      // A shape never changes tldraw page: un-framing re-parents to ITS page,
      // and a target frame must live on the same page as the shape.
      const shapePage = helpers.shapePageId(shape.id) ?? helpers.pageRecordId;
      if (targetFrameId && helpers.shapePageId(targetFrameId) !== shapePage) {
        throw new Error(
          `Frame "${frameName}" is on a different tldraw page than shape ${move.shape_id}; cross-page moves are not supported.`,
        );
      }
      const parentId =
        targetFrameId ?? (unframe ? shapePage : ((shape.parentId as string) ?? shapePage));
      const origin = parentId.startsWith("shape:")
        ? shapeAbsoluteOrigin(store, parentId)
        : { x: 0, y: 0 };
      shape.parentId = parentId;
      shape.x = move.x - origin.x;
      shape.y = move.y - origin.y;
      if (targetFrameId || unframe) shape.index = nextIndex(store);
    }
    let pageMove: { moved: number; arrowsMoved: number } | undefined;
    if (p.into_page) {
      const targetPage = helpers.resolveTargetPage(p.into_page);
      pageMove = moveShapesToPage(
        store,
        p.moves.map((m) => m.shape_id),
        targetPage,
      );
    }
    return {
      moved: p.moves.length - repointed,
      ...(repointed ? { repointed } : {}),
      ...(p.into_frame ? { intoFrame: frameName ?? "page" } : {}),
      ...(pageMove ? { intoPage: p.into_page, arrowsMoved: pageMove.arrowsMoved } : {}),
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
